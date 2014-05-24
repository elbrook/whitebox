// MailStorage.js
// Handle all persistent local storage – settings, an index file of header info, and message bodies.
//

var _ = require('underscore'),
 path = require('path-extra');
 
var fs = require('graceful-fs');
var mimelib = require('mimelib');


//
// Initializations
//
process.chdir(path.homedir());
if( !fs.existsSync('Emails') )
	fs.mkdirSync( 'Emails' );
process.chdir(path.homedir()+'/Emails/');

MailStorage();
FS();

var headers = FS.LoadHeadersFile();


function MailStorage() {
	//
	// List of public methods
	//
	MailStorage.GetSettings = GetSettings;
	MailStorage.GetSMTPSettings = GetSMTPSettings;
	MailStorage.AddSetting = AddSetting;
	MailStorage.GetAccounts = GetAccounts;
	
	MailStorage.GetHeaders = GetHeaders;
	MailStorage.GetHeader = GetHeader;
	MailStorage.AddHeader = AddHeader;
	MailStorage.SaveHeaders = SaveHeaders;
	
	MailStorage.GetUIDsInBox = GetUIDsInBox;
	MailStorage.GetUnseenUIDsInBox = GetUnseenUIDsInBox;
	MailStorage.DeleteExcept = DeleteExcept;
	
	MailStorage.SaveAttachment = SaveAttachment;
	MailStorage.SaveMessage = SaveMessage;
	
	MailStorage.DeleteMessage = DeleteMessage;
	MailStorage.MarkAsSeenInBox = MarkAsSeenInBox;
	MailStorage.MarkAsSeenByID = MarkAsSeenByID;
	
	
	//
	// Methods related to settings
	//
	function GetSettings() {
		return FS.LoadSettingsFile();
	}
	function GetSMTPSettings( accountName ) {
		return GetSettings()[accountName].smtp;
	}
	function AddSetting( accountName, settings ) {
		// THIS PROBABLY NEEDS TO BE DONE BY NUMBER, NOT ACCOUNTNAME
		if( !accountName )
			return;
		var currentSettings = GetSettings();
		currentSettings[accountName] = settings;
		FS.SaveSettingsFile( currentSettings );
		MailConnection.UpdateConnection( accountName, settings );
	}
	function GetAccounts() {
		return Object.keys( MailStorage.GetSettings() );
	}


	//
	// Methods related to headers
	//
	function GetHeaders() {
		return headers;
	}
	function GetHeader( GUID ) {
		return headers[GUID];
	}
	function AddHeader( connectionID, accountName, boxName, header ) {
		var GUID = makeGUID( connectionID, header.uid );
		if( !headers[GUID] ) headers[GUID] = {};
		headers[GUID].attributes = header;
		headers[GUID].account = accountName;
		headers[GUID].box = boxName;
		headers[GUID].id = GUID;
		headers[GUID].connectionID = connectionID;
		headers[GUID].parts = flattenStruct( header.struct );
		// console.log( GUID+': '+JSON.stringify(headers[GUID].parts) );
	}
	function SaveHeaders() {
		FS.SaveHeadersFile( headers );
	}
	
	
	//
	// Methods related to fetching 
	//
	function GetUIDsInBox( connectionID ) {
		var inBox = _.filter( headers, function(header){
			return header.connectionID == connectionID;
		});
		return _.map( inBox, function(header) {
			var num = parseInt(header.attributes.uid);
			return num? num:null;
		});
	}
	function GetUnseenUIDsInBox( connectionID ) {
		var boxHeaders = _.filter( headers, function(header) {
			return header.connectionID == connectionID;
		});
		var unseenHeaders = _.filter( boxHeaders, function(header) {
			return header.attributes.flags.indexOf("\\Seen") == -1;
		});
		return _.map( unseenHeaders, function(header) {
			return header.attributes.uid;
		});
	}
	function DeleteExcept( connectionID, UIDs ) {
		var myUIDs = GetUIDsInBox( connectionID );
		var superfluous = _.difference( myUIDs, UIDs );
		//console.log( myUIDs+' - '+UIDs+' = '+superfluous );
		superfluous.forEach( function(UID) {
			var GUID = makeGUID( connectionID, UID );
			DeleteMessage(GUID);
		});
	}
	
	
	//
	// Methods related to downloading messages
	//
	function SaveAttachment( GUID, attachment ) {
		FS.SaveAttachment( GUID, attachment.generatedFileName, attachment.stream );
	}
	function SaveMessage( GUID, message ) {
		if( !message.html )
			message.html = parseTextForHTML( message.subject, message.text ); 
		FS.SaveMessage( GUID, message.html );
	}


	//
	// Methods related to updating files
	//
	function DeleteMessage( GUID ) {
		delete headers[GUID];
		FS.DeleteMessage(GUID);
		// NEED TO DELTE ATTACHMENTS TOO
	}
	function MarkAsSeenInBox( accountName, boxName, UIDs ) {
		if( !UIDs || UIDs.length == 0 ) return;
		UIDs.forEach( function(UID) {
			var GUID = makeGUID(accountName, boxName, UID);
			MarkAsSeenByID( GUID );
		});
	}
	function MarkAsSeenByID( GUID ) {
		if( !headers[GUID] )
			return;
		headers[GUID].attributes.flags.push("\\Seen");
	}
	
	
	//
	// Utility functions
	//
	function makeGUID( connectionID, UID ) {
		//return escapeBoxName(connectionID)+'.'+UID;
		return connectionID+'/'+UID;
	}

	// For Gmail+fs+RegExp. Might be better to be more systematic about this...
	/*function escapeBoxName( name ) {
		var newName = name.replace('[','«');
		newName = newName.replace(']','»');
		return newName.replace('/','…');
	}*/
	/*function unescapeBoxName( name ) {
		var newName = name.replace('«','[');
		newName = newName.replace('»',']');
		return newName.replace('…','/');
	}*/

	function parseTextForHTML( subject, text ) {
		if( !text ) text = '';
		// THIS COULD BE GREATLY IMPROVED
		text = text.replace( / >/g, "\n>" );
		text = text.replace( /\s*[\n\r]\s*/gm,
				"\n"+'<br />'+"\n" ).trim();
		var html =
			'<div class="text" style="font-family: Cantarell, sans; font-size: 9pt; word-wrap: break-word; padding: 4%;">'+
			'<div class="subject" style="font-weight: bold; margin-bottom: 13pt;">'+
			mimelib.parseMimeWords(subject)+
			'</div>'+
			text+
			'</div>';
		//console.log(html);
		return html;
	}
	
	function flattenStruct( struct ) {
		if( !struct || typeof struct != 'object' )
			return {};
		var returnObject = {};
		if( struct.partID ) {
			if(
				struct.disposition &&
				(struct.disposition.type.toLowerCase() == 'attachment' ||
					(struct.disposition.type.toLowerCase() == 'inline' &&
					struct.disposition.params &&
					struct.disposition.params.filename)
				)
			) {
				returnObject.attachments = {};
				returnObject.attachments[struct.partID] = struct.disposition.params;
				if(returnObject.attachments[struct.partID] && !returnObject.attachments[struct.partID].size && struct.size)
					returnObject.attachments[struct.partID].size = struct.size;
			} else {
				if( struct.type == 'text' && struct.subtype == 'html' ) {
					returnObject.html = struct.partID;
				}
				if( struct.type == 'text' && struct.subtype == 'plain' ) {
					returnObject.text = struct.partID;
				}
			}
		}
		for( var i in struct ) {
			var addObject = flattenStruct(struct[i]);
			if( addObject.attachments ) {
				if( !returnObject.attachments ) returnObject.attachments = {};
				for( var j in addObject.attachments ) {
					returnObject.attachments[j] = addObject.attachments[j];
				}
			}
			if( addObject.text ) {
				if( !returnObject.text
				  || parseFloat(addObject.text) < parseFloat(returnObject.text) ) {
					returnObject.text = addObject.text;
				}
			}
			if( addObject.html ) {
				if( !returnObject.html
				  || parseFloat(addObject.html) < parseFloat(returnObject.html) ) {
					returnObject.html = addObject.html;
				}
			}
		}
		return returnObject;
	}
}


//
// File handing library
//
function FS() {
	// NEEDS A METHOD FOR DELETE EXTRANEOUS FILES
	
	//
	// List of public methods
	//
	FS.LoadSettingsFile = LoadSettingsFile;
	FS.LoadHeadersFile = LoadHeadersFile;
	
	FS.SaveAttachment = SaveAttachment;
	FS.SaveMessage = SaveMessage;
	FS.SaveHeadersFile = SaveHeadersFile;
	FS.SaveSettingsFile = SaveSettingsFile;
	
	FS.DeleteMessage = DeleteMessage;
	
	
	//
	// Implementations
	//
	function LoadSettingsFile() {
		if( fs.existsSync('Account settings.json') )
			return JSON.parse( fs.readFileSync('Account settings.json', {encoding: 'utf8'}) );
		else
			return {};
	}
	function LoadHeadersFile() {
		if( fs.existsSync('Headers.json') )
			return JSON.parse( fs.readFileSync('Headers.json',{encoding:'utf8'}) );
		else
			return {};
	}
	function SaveAttachment( GUID, fileName, stream ) {
		makePath('Emails/'+GUID);
		var file = fs.createWriteStream( 'Emails/'+GUID+'/'+fileName );
		stream.pipe(file); 
	}
	function SaveMessage( GUID, html ) {
		makePath('Emails/'+GUID);
		fs.writeFileSync( 'Emails/'+GUID+'/message.html', html );
	}
	function SaveHeadersFile( param ) {
		fs.writeFileSync( 'Headers.json', JSON.stringify(param) );
	}
	function SaveSettingsFile( settings ) {
		fs.writeFileSync('Account settings.json', JSON.stringify(settings));
	}
	function DeleteMessage( GUID ) {
		if( fs.existsSync( 'Emails/'+GUID+'/message.html' ) )
			fs.unlinkSync( 'Emails/'+GUID+'/message.html' );
	}

	function makePath( path ) {
		var folders = path.split('/');
		var checkPath = '';
		for( var i=0; i<folders.length; i++ ) {
			checkPath += folders[i]+'/';
			//console.log(checkPath);
			if( !fs.existsSync(checkPath) )
				fs.mkdirSync(checkPath);
		}
	}
}
