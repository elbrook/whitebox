// MailConnection.js
// Handle all Imap requests and connections, using node-imap and mailparser libraries.
//
// TO IMPROVE:
// -- ADD TIMEOUTS TO ALL FUNCTIONS… MAYBE IN INITACTION?
//
// TO FIX:
// -- SAVING MESSAGES (SENT, DRAFTS) HAS 1970 DATE (AND USUALLY NO MESSAGEID) EXCEPT ON GMAIL
// -- GMAIL AND OUTLOOK SAVE A COPY OF SMTP MESSAGE TO SENT BOX AUTOMATICALLY (WHICH MEANS WE'RE DOING IT TWICE) - FILTER LATER BY MESSAGEID


var Imap = require('imap'),
       _ = require('underscore'),
  moment = require('moment'),
MailParser = require('mailparser').MailParser,
  filesize = require('filesize');
  
var nodemailer = require('nodemailer'),
  MailComposer = require('mailcomposer').MailComposer;


//
// Initializations
//
MailConnection();
MailConnection.UpdateConnections( MailStorage.GetSettings() );

function MailConnection() {
	//
	// List of public methods
	//
	MailConnection.UpdateConnections = UpdateConnections;
	MailConnection.UpdateConnection = UpdateConnection;
	MailConnection.Update = Update;
	
	MailConnection.SetFlag = SetFlag;
	MailConnection.SendMessage = SendMessage;
	MailConnection.SaveDraft = SaveDraft;
	MailConnection.DownloadParts = DownloadParts;
	
	
	//
	// Global (i.e. persistent) variables
	//
	var connections = {};
	var connectionsQueue = {};
	
	
	//
	// Set up Imap connections
	//
	function UpdateConnections( settingsList ) {
		for( var accountName in settingsList ) {
			UpdateConnection( accountName, settingsList[accountName] );
		}
	}
	function UpdateConnection( accountName, settings ) {
		connections[accountName] = {};
		connections[accountName].boxConnections = {};
		connections[accountName].settings = settings;
		connections[accountName].name = accountName;
		connections[accountName].logName = Shorten( accountName, 20 );
			// for console.log
	}


	//
	// Main function
	// Start updating each account, return when done.
	//
	function Update( callback ) {
		if( ObjectSize(connectionsQueue) > 0 ) {
			console.log("Already updating");
			callback();
			return;
		}

		_.each( connections, function(account) {
			connectionsQueue[account.name] = true;
			updateMessagesOnAccount( account );
		});
		
		var waitTimer = setInterval( waitUpdates, 5000 );
		function waitUpdates() {
			if( ObjectSize(connectionsQueue) == 0 ) {
				clearInterval(waitTimer);
				callback();
			}
		}
	}


	//
	// Sync messages
	// Do fetch on every box. Get boxes list if connections aren't set up yet.
	//
	function updateMessagesOnAccount( account ) {
		
		if( ObjectSize(account.boxConnections ) == 0 ) {
			getBoxesList( account, syncBoxesOnAccount, function(err) {
				fetchLog( err, '', '', '' );
			});
		} else {
			syncBoxesOnAccount( account );
		}
		
	}

	// Start sync on every box, and wait till they're done
	function syncBoxesOnAccount( account ) {
		
		var boxesQueue = {};
		
		// Call sync on each box
		_.each( account.boxConnections, function(connection) {
			boxesQueue[connection.boxName] = true;
			syncBox( connection, function() {
				delete boxesQueue[connection.boxName];
			});
		});
		startSyncWait();
		
		// Wait for syncing to end
		var waitTimer;
		function startSyncWait() {
			waitTimer = setInterval( syncWatch, 5000 );
		}
		function syncWatch() {
			if( ObjectSize(boxesQueue) == 0 ) {
				cleanupAccount();
			}
		}
		function cleanupAccount() {
			clearInterval(waitTimer);
			delete connectionsQueue[account.name];
		}
	}
			
	// Do the sync
	function syncBox( imap, callback ) {
		var syncTimeout = setTimeout( syncCleanup, 1000*60*3 );
		
		var searchDate = moment().subtract(6,'months').toDate();
		
		imap.search([ ['SINCE', searchDate] ], function(err, UIDs) {
			if(err) {
				syncLog( err );
				syncCleanup();
				return;
			}
			if( UIDs.length == 0 ) {
				syncCleanup();
				return;
			}
			
			// Clean up local files
			MailStorage.DeleteExcept( imap.id, UIDs );

			// Update \Seen flags in saved headers
			imap.search([ 'UNSEEN',['SINCE',searchDate] ], function(err,unseenUIDs) {
				var newlySeenUIDs = _.difference(
					MailStorage.GetUnseenUIDsInBox(imap.id),
					unseenUIDs );
				if( newlySeenUIDs.length > 0 )
					MailStorage.MarkAsSeenInBox( imap.id, newlySeenUIDs );
			});
			
			// Download the headers we don't have
			var newMessages = _.difference(
				UIDs,
				MailStorage.GetUIDsInBox(imap.id) );
			syncLog( 'Fetch total: ' + newMessages.length );
			if( newMessages.length>0 ) {
				var f = imap.fetch( newMessages, {
					envelope: true,
					struct: true
				});
				f.on( 'message', function(message, seqnum) {
					message.once('attributes', function(attributes) {
						MailStorage.AddHeader(imap.id, imap.account, imap.box, attributes);
					});
				});						
				f.once( 'end', function() {
					syncCleanup();
				});
				f.once( 'error', function(err) {
					syncLog( err );
					syncCleanup();
				});
			} else {
				syncCleanup();
			}
		});
	
		function syncCleanup() {
			clearTimeout( syncTimeout );
			syncLog( 'Box done' );
			MailStorage.SaveHeaders();
			callback();
		}
		function syncLog( message ) {
			UI.UpdatesLog( imap.logName + ': ' + message );
			console.log( imap.logName + ': ' + message );
		}
	}
	

	//
	// Get boxes list
	//
	function getBoxesList(account, callback, onError) {
		
		console.log( account.logName+': getBoxesList' );
		
		var boxProgress = [];
		// Wait for the connections to be established
		var waitTimer;
		function waitBoxes() {
			if( boxProgress.length == 0 ) {
				clearInterval( waitTimer );
				callback( account );
			}
		}
		
		initAction( account.name, null, function(imap) {
			console.log( account.logName+': getBoxesList - connection ready' );
			
			imap.getBoxes( function(err,boxes) {
				if(err) {
					console.log( imap.logName+': '+err );
					if( onError ) onError(err);
					return;
				}
				
				// Find all the right box names
				account.inbox = 'INBOX'; // Do we need to check this?
				account.sentBoxes = recurseBox( '', boxes, imap.delimiter, 'Sent' );
				account.draftBoxes = recurseBox( '', boxes, imap.delimiter, 'Draft' );
				account.allBoxes = account.sentBoxes.concat( account.draftBoxes ).concat( [account.inbox] );
			
				// Open a connection to every box
				console.log( imap.logName + ': found boxes: ' + account.allBoxes );
				
				account.allBoxes.forEach( function(boxName) {
					boxProgress.push(boxName);
					initAction( account.name, boxName, function(connection) {
						
						account.boxConnections[boxName] = connection;
						boxProgress.splice( boxProgress.indexOf(boxName), 1 );
						//console.log( connection.logName+': created. '+boxProgress.length+' left' );
						
					});
				});
				
				waitTimer = setInterval( waitBoxes, 5000 );
				
			});
		}, onError);
		
		// Helper function to search for relevant boxes in box Object
		function recurseBox( path, box, delimiter, searchString, depth ) {
			var boxNames = [];
			if( !depth ) {depth = 0} else {
				if( depth>1 ) return boxNames;
			}
			for( var i in box ) {
				if( i.indexOf(searchString) > -1 ) {
					boxNames.push(path+i);
				}
				if( box[i].children ) {
					var newNames = recurseBox( path+i+delimiter, box[i].children, delimiter, searchString, depth+1 );
					if( newNames.length > 0 ) {
						boxNames = boxNames.concat(newNames);
					}
				}
			}
			return boxNames;
		}

	}


	//
	// Update flags (including delete)
	//
	function SetFlag( GUID, flag, callback ) {
		var message = MailStorage.GetHeader(GUID);
		
		initAction( message.account, message.box, function(imap) {
			
			console.log( 'Marking '+message.box+'.'+message.attributes.uid+' '+flag+' '+message.account );	

			imap.addFlags( message.attributes.uid, flag, function(err) {

				if(err) {
					console.log(err);
				} else {
					if( flag == "\\Deleted" ) {

						// Need to close box once to finalize change
						imap.closeBox( function(err) {
							if(err) { console.log(err); }
							else {
								imap.openBox( message.box, function(err,box) {
									if(err) console.log(err);
									else cleanup(); // only if successful
								});
							}
						});
						
					} else {
						cleanup();					
					}
				}
			});
		});
		
		function cleanup() {
			console.log( 'Marked '+message.box+'.'+message.attributes.uid+' '+flag+' '+message.account );
			callback(); // only if successful
		}
	}


	//
	// Send mail
	//
	function SendMessage( sendAccount, messageOptions, callback ) {
		var smtpTransport = nodemailer.createTransport("SMTP",
			MailStorage.GetSMTPSettings(sendAccount));
		
		smtpTransport.sendMail(messageOptions, function(err,response) {
			if(err) {
				console.log(err); callback(err);
			} else {
				console.log('Message sent: '+response.message);
				UI.SendProgress('Message sent. Saving to sent messages…');
				var mailcomposer = new MailComposer();
				mailcomposer.setMessageOption( messageOptions );
				mailcomposer.buildMessage( function(err,messageSource) {
					if(err) { console.log(err); callback(err); }
					else {
						saveSentMail( messageSource, sendAccount, callback );
					}
				});
			}
		});	
	}


	//
	// Save messages
	//
	function SaveDraft( messageOptions, accountName, callback ) {
		console.log('Saving draft');
		var mailcomposer = new MailComposer();
		mailcomposer.setMessageOption( messageOptions );
		mailcomposer.buildMessage( function(err,messageSource) {
			if(err)
				console.log(err);
			else
				saveDraftMail( messageSource, accountName, callback );
		});
	}
	function saveSentMail( mailStream, accountName, callback ) {
		var account = connections[accountName];
		if( !account.sentBoxes )
			getBoxesList( account, function() {
				saveMessageToBox( mailStream, accountName, account.sentBoxes[0], ["\\Seen"], callback );
			});
		else
			saveMessageToBox( mailStream, accountName, account.sentBoxes[0], ["\\Seen"], callback );
	}
	function saveDraftMail( mailStream, accountName, callback ) {
		var account = connections[accountName];
		if( !account.draftBoxes )
			getBoxesList( account, function() {
				saveMessageToBox( mailStream, accountName, account.draftBoxes[0], [], callback );
			});
		else
			saveMessageToBox( mailStream, accountName, account.draftBoxes[0], [], callback );
	}
	function saveMessageToBox( mailStream, accountName, boxName, flags, callback ) {
		initAction( accountName, boxName, function(imap) {
			imap.append( mailStream, {
				mailbox:boxName,
				flags:flags,
				date: new Date() // NOT WORKING EVEN WITH THIS SET. A BUG IN THE LIBRARY?
			}, function(err) {
				if(err)	{
					console.log(err);
					callback(err);
				} else {
					console.log('Message saved to '+boxName);
					callback();
				}
			});
		});
	}
	

	//
	// Download message bodies, including attachments
	//
	function DownloadParts( GUID, callback ) {

		console.log('Need to download '+GUID);
		UI.SetupDownloadIndicator('Downloading message from server. Connecting…');
		var message = MailStorage.GetHeader( GUID );

		initAction( message.account, message.box, function(imap) {

			console.log('Opened box for download');
			UI.DownloadProgress('Connected.');

			var f = imap.fetch( message.attributes.uid, {bodies: ''} );

			f.on('message', function(message, seqnum) {

				var mailparser = new MailParser({streamAttachments: true});
				var buffer = '';

				message.on('body', function(stream, info) {
					stream.pipe(mailparser);
					UI.DownloadProgress(filesize(info.size)+' total to download.');
					stream.on('data', function(chunk) {
						buffer += chunk;
					});
					stream.once('end', function() {
						console.log(buffer);
					});
				});

				mailparser.on('attachment', function(attachment) {
					MailStorage.SaveAttachment(GUID, attachment);
					console.log(JSON.stringify(attachment));
					attachment.stream.on('data', function(chunk) {
						UI.DownloadAttachmentProgress(attachment.generatedFileName, chunk.length);
					});
				});

				mailparser.once('end', function(mail) {
					MailStorage.SaveMessage(GUID, mail);
					callback();
					UI.EndDownloadIndicator();
				});
			});

			f.once('error', function(err) {
				console.log(err);
				UI.EndDownloadIndicator();
			});

			f.once('end', function() {
			});
		}, function(err){
			UI.DownloadProgress(err);
			setTimeout( function(){UI.EndDownloadIndicator();}, 3000 ); 
		});
	}


	//
	// Helper functions
	//
	function initAction( accountName, boxName, callback, onError ) {
		
		// console.log( 'initAction '+accountName );

		if( boxName != null &&
			connections[accountName].boxConnections[boxName] &&
			connections[accountName].boxConnections[boxName].state != "disconnected" ) {
			callback( connections[accountName].boxConnections[boxName] );
			return;
		}
			
		console.log( connections[accountName].logName+': creating new connection' );
			 		
		var imap = new Imap( connections[accountName].settings );
		imap.id = accountName + '/' + boxName;
		imap.account = accountName;
		imap.box = boxName;
		imap.logName = Shorten( accountName + boxName, 20 );

		imap.connect();
		imap.once( 'ready', function() {
			if( boxName ) {
				imap.openBox( boxName, function(err,box) {
					if(err) {
						console.log('Error: '+err);
						if( onError ) onError(err);
					} else {
						callback(imap, box);
						onError = null;
					}
				});
			} else {
				callback(imap);
				onError = null;
			}
		});
		
		imap.once( 'error', function(err) {
			console.log(err);
			if( onError ) onError(err);
		});
	}

	
	//
	// Generic helper functions
	//
	function ObjectSize( obj ) {
		var size = 0;
		for( var key in obj ) {
			if( obj.hasOwnProperty(key) ) size++;
		}
		return size;
	}
	function resetTimeout( timeout, callback, duration ) {
		clearTimeout( timeout );
		return setTimeout( callback, duration );
	}
	function Shorten( string, l ) {

		var newString = removeEvenly( string, l, 'vowels' );

		if( newString.length > l )
			newString = removeEvenly( newString, l, 'all' );
			
		// console.log( newString + ' = ' + newString.length + ' == ' + l );
		return newString;	
	}		
	function removeEvenly( string, l, type ) {
		
		var matches;
		if( type == 'vowels' )
			matches = string.match( /[aeiou]/gi );
		else
			matches = string;

		var removeEvery;
		if( string.length - l >= matches.length )
			removeEvery = 1;
		else
			removeEvery = matches.length / (string.length - l);

		var	nextRemove = removeEvery - 1,
			newString = "",
			matchIndex = 0;
		
		for( var i=0; i<string.length; i++ ) {
			
			if( string[i] == matches[matchIndex] ) {
				
				if( matchIndex == Math.round( nextRemove ) ) {
					nextRemove += removeEvery;
				} else {
					newString += string[i];
				}
				matchIndex++;
				
			} else {
				newString += string[i];
			}
			
		}
		
		return newString;
	}	
}
