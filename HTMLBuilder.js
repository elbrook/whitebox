// HTML-builder.js
// A middle-man converting email objects in local storage into HTML.
//
// TO FIX:
// -- REMOVE ALL REFERENCES TO MAILSTORAGE
// -- SOME MESSAGES DON'T SHOW THE RIGHT ENCODING... (EXAMPLES OF JAPANESE)


var mimelib = require('mimelib'),
	 moment = require('moment'),
   filesize = require('filesize'),
		 fs = require('graceful-fs'),
	   path = require('path-extra');
	   

var MailHeaders = UI_loadHeaders();

function UI_loadHeaders() {
	MailHeaders = MailStorage.GetHeaders();
	return MailHeaders;
}

function getMailboxHTML() {
	var headers = UI_loadHeaders();
	headers = _.sortBy( headers, function(header){ return new Date(header.attributes.envelope.date) } ).reverse();
	
	var HTML = _.map( headers, function(header) {
		var s = '<div ';
			s+= 'id="'+header.id+'" ';
			s+= 'class="message';
			s+= header.attributes.flags.indexOf("\\Seen")==-1? ' unseen':'';
			s+= ' a'+accountToNum(header.account);
			s+= header.parts.attachments? ' hasAttachments':'';
			s+= '">';
			s+= '<div class="date">'+parseDate(header.attributes.envelope.date)+'</div>';
			s+= '<div class="from">'+parseName(header.attributes.envelope.from)+'</div>';
			s+= '<div class="subject">'+decode(header.attributes.envelope.subject)+'</div>';
			s+= '</div>'
		return s;
	}).join("\n");
	
	return HTML;
}


var lastMessage = {};
function getMessageHTMLSrcByID( ID, callback ) {
	//console.log(ID);
	var header = MailHeaders[ID];
	var filePath = path.homedir()+'/Emails/Emails/'+ID;
	var attachments = _.map(header.parts.attachments, function(field) {
		return '<div class="button attachment" id="'+filePath+'/'+field.filename+'">'+field.filename+' ('+filesize(field.size)+')</div>';
	}).join(' ');
	if( !fs.existsSync(filePath) ) {
		// NEED A CHECK TO SEE IF ALREADY TRYING TO LOAD
		MailConnection.DownloadParts(ID, function() {
			callback( filePath+'/message.html', attachments );
		});
	} else {
		callback( filePath+'/message.html', attachments );
	}
}
function getMessageHeaderByID( ID ) {
	var header = MailHeaders[ID];
	var text = 'to: '+parseAddresses(header.attributes.envelope.to);
		text+= ' cc: '+parseAddresses(header.attributes.envelope.cc);
		text+= '<p>date: '+header.attributes.envelope.date;
		text+= '<p>mailbox: '+header.box;
		text+= ' flags: '+header.attributes.flags;
		text+= '<p>ID: '+header.attributes.envelope.messageId;
	return text;
}
function getComposeHeaderByID( ID ) {
	var text = 'from: ';
		text+= ID? MailHeaders[ID].account : getDefaultAccount();
	return text;
}
function getSendAccountByID( ID ) {
	if(!ID) return getDefaultAccount();
	var header = MailHeaders[ID];
	return header.account;
}
function getAccountClassByID( ID ) {
	if(!ID) return 'a'+accountToNum( getDefaultAccount() );
	var header = MailHeaders[ID];
	return 'a'+accountToNum( header.account );
}
function getAddressesExceptMine( ID ) {
	var header = MailHeaders[ID];
	var list = header.attributes.envelope.to.concat(header.attributes.envelope.cc).concat(header.attributes.envelope.from);
	list = _.reject( list, function(addressField) {
		if(!addressField)
			return true;
		return addressField.mailbox+'@'+addressField.host == parseIDForAccountName(ID);
	});
	return parseAddresses(list);
}
function getSubject( ID ) {
	return MailHeaders[ID].attributes.envelope.subject;
}


//
// Helper functions
//
function parseIDForAccountName(ID) {
	return ID.substr(0,ID.indexOf('/'));
}

function accountToNum( account ) {
	return MailStorage.GetAccounts().indexOf(account);
}
function numToAccount( num ) {
	return MailStorage.GetAccounts()[num];
}
function getAccountNames() {
	return MailStorage.GetAccounts();
}
function getDefaultAccount() {
	return MailStorage.GetAccounts()[0];
}

function parseText( text ) {
	return text? text.replace(/(\s*\n\s*)+/gm,'<p>' ).trim():"";
}

function parseDate( dateString ) {
	var date = moment( new Date(dateString) );
	var displayDate = date.format("MMM D");
	if( date.format("Y M D") == moment().format("Y M D") )
		displayDate = date.format("h.mma");
	if( date.format("Y M D") == moment().subtract('days',1).format("Y M D") )
		displayDate = "Yesterday";
	return displayDate;
}

function parseName( addressField ) {
	if( !addressField ) return '';
	return parseAddressFieldForName( addressField[0] );
}
function parseNames( addressField ) {
	if( !addressField ) return '';
	var names = "";
	addressField.forEach( function(field) {
		names += parseAddressFieldForName(field) + ' ';
	});
	return names;
}
function parseAddressFieldForName( addressField ) {
	if( !addressField ) return '';
	var name = decode(addressField.name);
	if( !name ) {
		name = addressField.mailbox + '@' + addressField.host;
		if( !name )
			return '';
	}
	return name;
}

function parseAddresses( addressField ) {
	if( !addressField ) return '';
	var text = '';
	for( var i=0; i<addressField.length; i++ ) {
		text += addressField[i].mailbox + '@' + addressField[i].host;
		if( i<addressField.length-1 )
			text += ', ';
	}
	return text;
}

function decode( string ) {
	return mimelib.parseMimeWords(string);
}
