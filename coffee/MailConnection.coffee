# MailConnection.coffee
# Handle all Imap requests and connections, using node-imap and mailparser libraries.
#
# TO FIX:
# -- SAVING MESSAGES (SENT, DRAFTS) HAS 1970 DATE (AND USUALLY NO MESSAGEID) EXCEPT ON GMAIL
# -- GMAIL AND OUTLOOK SAVE A COPY OF SMTP MESSAGE TO SENT BOX AUTOMATICALLY (WHICH MEANS WE'RE DOING IT TWICE) - FILTER LATER BY MESSAGEID


Imap = require 'imap'
_ = require 'underscore'
moment = require 'moment'
MailParser = require('mailparser').MailParser
filesize = require 'filesize'

nodemailer = require 'nodemailer'
MailComposer = require('mailcomposer').MailComposer

# MailStorage = require('./MailStorage').MailStorage
# MailStorage = { GetSettings: () -> { } }


###############################################################################
# General utility functions
###############################################################################

# Convert message GUID to connection ID
GUIDToConnectionID = ( GUID ) -> GUID.substr 0, GUID.lastIndexOf '№'

# Convert message GUID to message UID in box context
GUIDToUID = ( GUID ) -> GUID.substr GUID.lastIndexOf( '№' ) + 1

# Convert account name + box name to connection ID
ConnectionID = ( AccountName, BoxName ) -> AccountName + '/' + BoxName


###############################################################################
# Asynchronous library
###############################################################################

class Ʃ

	# Modify every object item with Iterator
	@Map: ( List, Iterator, autocb ) ->
		ReturnObject = {}
		await Ʃ.ForEach List, ( Value, Key, autocb ) ->
			await Iterator Value, Key, defer NewValue
			ReturnObject[Key] = NewValue
		, defer()

		ReturnObject


	# Modify Memo with Iterator for every item
	@Reduce: ( List, Iterator, Memo, autocb ) ->
		await Ʃ.ForEach List, ( Value, Key, autocb ) ->
			await Iterator Value, Key, ( () -> Memo ), defer MergedMemo
			Memo = MergedMemo
		, defer()

		Memo


	# Call Iterator on every item of Object
	@ForEach = ( List, Iterator, autocb ) ->
		await
			for i of List when List.hasOwnProperty i
				((Value, Key, autocb) ->
					await Iterator Value, Key, defer()
				)(List[i], i, defer())


	# Reduce list of Candidates into a boolean True or False depending on match
	@FindMatch = ( Text, Candidates, autocb ) ->
		await Ʃ.Reduce Candidates, ( Candidate, Index, OtherMatches, autocb ) ->
			return OtherMatches() if OtherMatches()
			Text.toLowerCase().indexOf( Candidate ) > -1
		, false, defer Match

		Match


###############################################################################
# Main class object
###############################################################################

class MailConnection

	#
	# List of public methods
	#
	# MailConnection.UpdateConnections
	# MailConnection.SyncAll
	# MailConnection.DownloadMessage


	#
	# Persistent variables
	#
	Connections = {}


	#
	# Set up connections
	#
	@UpdateConnections = ( SettingsList ) ->

		await Ʃ.Reduce SettingsList, ( Setting, AccountName, MasterList, autocb ) ->
			
			await UpdateAccount Setting, AccountName, defer BoxNames
			await Ʃ.Map BoxNames, ( BoxName, Index, autocb ) ->
				ConnectionID AccountName, BoxName
			, defer ConnectionsList

			MasterList().concat ConnectionsList

		, [], defer UpdatedList

		HoldOvers = _.difference Object.keys( Connections ), UpdatedList
		delete Connections[ HoldOver ] for HoldOver of HoldOvers

		UpdatedList # return only the keys, i.e. ConnectionIDs


	# Merges connections from account with global Connections
	UpdateAccount = ( Settings, AccountName, autocb ) ->

		await GetBoxesList Settings, defer BoxesList
		await Ʃ.Reduce BoxesList, ( BoxName, Index, MasterList, autocb ) ->

			# If there's already a working connection to this box, don't change it
			return MasterList() if MasterList()[ ConnectionID AccountName, BoxName ]

			await InitBox Settings, AccountName, BoxName, defer NewConnection

			_.extend MasterList(), NewConnection

		, Connections, defer NewConnections

		BoxesList


	#
	# Syncing messages
	# (Call Sync on every available connection)
	#
	@SyncAll = ( autocb ) ->

		await Ʃ.ForEach Connections, Sync, defer()


	# Sync local message headers with remote message headers
	Sync = ( Connection, ConnectionID, autocb ) ->

		# Limit sync to recent 6 months
		SearchDate = moment().subtract( 6, 'months' ).toDate()

		await Connection.search [['SINCE', SearchDate]], defer err, UIDs
		return if err || UIDs.length == 0

		StoredMessages = MailStorage.GetUIDsInBox ConnectionID

		# Fetch headers we don't have
		NewMessages = _.difference UIDs, StoredMessages
		await FetchHeaders( Connection, NewMessages, defer() ) unless NewMessages.length == 0

		# Find messages no longer unseen
		await Connection.search ['UNSEEN', ['SINCE',SearchDate]], defer err, UnseenUIDs
		UpdateAsSeenUIDs = _.difference MailStorage.GetUnseenUIDs( ConnectionID ), UnseenUIDs
		MailStorage.MarkAsSeen UpdateAsSeenUIDs.map (UID) -> ConnectionID+'№'+UID

		# Delete superfluous local files
		await MailStorage.DeleteMessages _.difference( StoredMessages, UIDs ), defer()


	# Fetch remote headers
	FetchHeaders = ( Connection, UIDs, autocb ) ->

		f = Connection.fetch UIDs, { envelope: true, struct: true }

		f.on 'message', ( message, seqnum ) ->
			message.once 'attributes', ( attributes ) ->
				MailStorage.addHeader Connection.id, attributes

		await f.once 'end', defer()


	#
	# Downloading messages
	# NEEDS ERROR HANDLING, LOGGING, TIMEOUT, ETC
	#
	@DownloadMessage = ( GUID, autocb ) ->

		Connection = Connections[ GUIDToConnectionID GUID ]
		f = Connection.fetch GUIDToUID, { bodies: '' }

		await f.on 'message', defer message, seqnum
		mailparser = new MailParser { streamAttachments: true }

		message.on 'body', ( stream, info ) ->
			stream.pipe MailParser

		mailparser.on 'attachment', ( attachment ) ->
			MailStorage.SaveAttachment GUID, attachment

		await mailparser.once 'end', defer mail
		MailStorage.SaveMessage mail


	#
	# Mailbox utility functions
	# Connect to an account based on Settings, then reduce Boxes Object to an Array
	#
	GetBoxesList = ( Settings, autocb ) ->

		await InitConnection Settings, defer Connection
		await Connection.getBoxes defer err, Boxes

		await Ʃ.Reduce Boxes, RecurseBoxForMatches, [], defer BoxesList

		BoxesList


	# Recurse branch, adding BoxName if it matches defaults, then merge
	RecurseBoxForMatches = ( Box, BoxName, MasterList, autocb ) ->
		console.log BoxName + ': ' + Box
		if Box.children
			await Ʃ.Reduce Box.children, RecurseBoxForMatches, [], defer BranchList
		else
			BranchList = []
		await Ʃ.FindMatch BoxName, ['inbox', 'sent', 'draft'], defer Match
		BranchList.push BoxName if Match
		MasterList().concat BranchList


	# Open connection and return the Connection
	InitConnection = ( Settings, autocb ) ->
		Connection = new Imap( Settings )
		Connection.connect()
		Connection.once 'error', ( err ) ->
			console.log err
		await Connection.once 'ready', defer()
		Connection


	# Open box and return the Connection as a dictionary
	InitBox = ( Settings, AccountName, BoxName, autocb ) ->
		await InitConnection Settings, defer Connection
		await Connection.openBox BoxName, defer( err, BoxObject )
		Connection.id = AccountName + '/' + BoxName
		ReturnObject = {}
		ReturnObject[ Connection.id ] = Connection
		ReturnObject


###############################################################################
# MailConnection initializations
###############################################################################

	# Connections = MailConnection.UpdateConnections MailStorage.GetSettings()
	# MailConnection.SyncAll()


###############################################################################
# Tests
###############################################################################

# Test my asynchronous library
RunAsyncTests = () ->

	# Simple test of await-defer
	console.log "Start tests. Pause 1 second."
	await
		setTimeout defer(), 1000
	console.log "Done waiting"

	RunTestOn = ( List, autocb ) ->
		# Test ForEach
		await Ʃ.ForEach List, ( Value, Key, autocb ) ->
			await setTimeout defer(), Math.random()*10
			console.log Key+': '+Value
		, defer()


		# Test Map
		await Ʃ.Map List, ( Value, Key, autocb ) ->
			await setTimeout defer(), Math.random()*10
			console.log Key
			Key
		, defer List
		console.log List


		# Test Reduce
		await Ʃ.Map List, ( ( Value, Key, autocb ) -> 2 ), defer List
		await Ʃ.Reduce List, ( Value, Key, PartialSum, autocb ) ->
			await setTimeout defer(), Math.random()*10
			console.log Key+':'+Value+' = '+PartialSum()
			PartialSum()+Value
		, 0, defer Sum
		console.log Sum
		console.log 'Test passed' if Sum==20
		console.log 'Test failed' if Sum!=20

	console.log "Testing Object"
	await RunTestOn { a:0, b:0, c:0, d:0, e:0, f:0, g:0, h:0, i:0, j:0 }, defer()
	console.log "Testing Array"
	await RunTestOn [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ], defer()


###############################################################################
# Tests to run
###############################################################################

RunAsyncTests()


###############################################################################
# Initializations
###############################################################################

# MailConnection()
