// MailConnection.js
// Handle all Imap requests and connections, using node-imap and mailparser libraries.
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
// Global (i.e. persistent) variables
//
var connections = {};
var connectionsQueue = [];


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
	// Set up Imap connections
	//
	function UpdateConnections( settingsList ) {
		for( var accountName in settingsList ) {
			UpdateConnection( accountName, settingsList[accountName] );
		}
	}
	function UpdateConnection( accountName, settings ) {
		connections[accountName] = new Imap(settings);
		connections[accountName].name = accountName;
		connections[accountName].logName = accountName.substr(0,10);
			// for console.log
	}


	//
	// Main function
	//
	function Update( callback ) {
		if( connectionsQueue.length > 0 ) {
			console.log("Already updating");
			callback();
			return;
		}

		updateMessages();
		
		var timer = setInterval( waitUpdates, 5000 );
		function waitUpdates() {
			if( connectionsQueue.length == 0 ) {
				clearInterval(timer);
				callback();
			}
		}
	}


	//
	// Sync messages
	//
	function updateMessages() {
		
		_.each( connections, function(imap) {
			
			connectionsQueue.push(imap.name);
			
			var boxesQueue = [];
			
			if( !imap.inbox || !imap.sentBoxes || !imap.draftBoxes )
				getBoxesList(imap.name, fetchMessages, function(err){
					fetchLog( 'Account error', '', '', err );
					connectionsQueue.pop()
				});
			else
				fetchMessages();
				
			// Call fetch on every box
			function fetchMessages() {
				imap.allBoxes.forEach( function(boxName) {
					boxesQueue.push( {boxName:boxName} );
					initAction( imap.name, boxName, doFetch, function(){ boxesQueue.pop() } );
				});
				startFetchWatch();
			}
			
			// Keep track of fetch progress
			var timer;
			var inactivityCount = 0;
			var lastQueueLength;
			function startFetchWatch() {
				timer = setInterval( fetchWatch, 5000 );
				lastQueueLength = boxesQueue.length
			}
			function fetchWatch() {
				// Calculate progress
				var percentDone =
					( 1 - boxesQueue.length / imap.allBoxes.length ) *100;
				
				if( boxesQueue.length < lastQueueLength ) {
					lastQueueLength = boxesQueue.length;
					inactivityCount = 0;
					UI.UpdatesProgress( imap.name, percentDone );
				} else {
					// If there's been no activity, get ready to time out
					inactivityCount++;
					fetchLog( 'Inactive', '', '', inactivityCount*5+' seconds' );
				}
				
				// Check if done
				if( boxesQueue.length == 0 || inactivityCount >= 36 /*3min*/ ) {
					clearInterval( timer );
					fetchLog( 'Account done', '', '', '');
					MailStorage.SaveHeaders();
					UI.Refresh();
					connectionsQueue.pop();
				}
			}
			
			// Sync mailbox
			function doFetch( imap, box ) {
				var searchDate = moment().subtract(6,'months').toDate();
				imap.search([ ['SINCE', searchDate] ], function(err, UIDs) {
					if(err) {
						fetchLog( 'Error', box.name, '', err );
						boxCleanUp();
						return;
					}
					if( UIDs.length == 0 ) {
						boxCleanUp();
						return;
					}
					
					// Clean up local files
					MailStorage.DeleteExcept( imap, box, UIDs );

					// Update \Seen flags in saved headers
					imap.search([ 'UNSEEN',['SINCE',searchDate] ], function(err,unseenUIDs) {
						var newlySeenUIDs = _.difference(
							MailStorage.GetUnseenUIDsInBox(imap.name, box.name),
								unseenUIDs );
						MailStorage.MarkAsSeenInBox( imap, box, newlySeenUIDs );
					});
					
					// Download headers we don't have
					var newMessages = _.difference(UIDs, MailStorage.GetUIDsInBox(imap.name, box.name));
					fetchLog( 'Fetch total', box.name, '', newMessages.length );
					if( newMessages.length>0 ) {
						var f = imap.fetch( newMessages, {
							envelope: true,
							struct: true
						});
						f.on( 'message', function(message, seqnum) {
							message.once('attributes', function(attributes) {
								MailStorage.AddHeader(imap.name, box.name, attributes);
							});
						});						
						f.once( 'end', function() {
							boxCleanUp();
						});
						f.once( 'error', function(err) {
							fetchLog( 'Error', box.name, '', err );
							boxCleanUp();
						});
					} else {
						boxCleanUp();
					}
				});
			}
			
			// Fetch utilities
			function boxCleanUp() {
				imap.lock = false;
				boxesQueue.pop();
				fetchLog( 'Box done', '', '', '' );
			}
			function fetchLog( type, boxName, UID, param, param2 ) {
				var ID = boxName+'.'+UID;
				switch(type) {
					case 'Box done':
						recentActivity = 1;
						boxPercentDone = 0;
						doPrint();
						break;
					default:
						doPrint();
				}
				function doPrint() {
					var header = imap.logName+'/'+ID+': ';
					//console.log( header+type+' '+param );
					UI.UpdatesLog( header+type+' '+param );
				}
			}
		}); // END _.each loop of connections
	}	// END updateMessages()


	//
	// Get boxes list
	//
	function getBoxesList(accountName, callback, onError) {
		var imap = connections[accountName];
		initAction( imap.name, null, function(imap) {
			imap.getBoxes( function(err,boxes) {
				if(err) {
					console.log( imap.logName+': '+err );
					imap.lock = false;
					if( onError ) onError(err);
					return;
				}
				
				imap.inbox = 'INBOX'; // Do we need to check this?
				imap.sentBoxes = recurseBox( '', boxes, 'Sent' );
				imap.draftBoxes = recurseBox( '', boxes, 'Draft' );
				imap.allBoxes = imap.sentBoxes.concat( imap.draftBoxes ).concat( [imap.inbox] );
			
				console.log( imap.logName + ': found boxes: ' + imap.allBoxes );
				imap.lock = false;
				callback();
				onError = null; // Never call both callback and onError
				
				function recurseBox( path, box, searchString, depth ) {
					var boxNames = [];
					if( !depth ) {depth = 0} else {
						if( depth>1 ) return boxNames;
					}
					for( var i in box ) {
						if( i.indexOf(searchString) > -1 ) {
							boxNames.push(path+i);
						}
						if( box[i].children ) {
							var newNames = recurseBox( path+i+imap.delimiter, box[i].children, searchString, depth+1 );
							if( newNames.length > 0 ) {
								boxNames = boxNames.concat(newNames);
							}
						}
					}
					return boxNames;
				}
			});
		}, onError);
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
					imap.lock = false;
				} else {
					imap.closeBox( function(err) {
						if(err) {
							console.log(err);
							imap.lock = false;
						} else {
							console.log( 'Marked '+message.box+'.'+message.attributes.uid+' '+flag+' '+message.account );
							imap.lock = false;
							callback(); // only if successful
						}
					});
				}
			});
		});
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
		if( !connections[accountName].sentBoxes )
			getBoxesList( accountName, function() {
				saveMessageToBox( mailStream, accountName, connections[accountName].sentBoxes[0], ["\\Seen"], callback );
			});
		else
			saveMessageToBox( mailStream, accountName, connections[accountName].sentBoxes[0], ["\\Seen"], callback );
	}
	function saveDraftMail( mailStream, accountName, callback ) {
		if( !connections[accountName].draftBoxes )
			getBoxesList( accountName, function() {
				saveMessageToBox( mailStream, accountName, connections[accountName].draftBoxes[0], [], callback );
			});
		else
			saveMessageToBox( mailStream, accountName, connections[accountName].draftBoxes[0], [], callback );
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
					imap.lock = false;
					callback(err);
				} else {
					console.log('Message saved to '+boxName);
					imap.lock = false;
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
		UI.SetupDownloadIndicator('Downloading message from server…');
		var message = MailStorage.GetHeader( GUID );
		initAction( message.account, message.box, function(imap) {
			console.log('Opened box for download');
			UI.DownloadProgress('Connected.');
			var f = imap.fetch( message.attributes.uid, {bodies: ''} );
			f.on('message', function(message, seqnum) {
				var mailparser = new MailParser({streamAttachments: true});
				message.on('body', function(stream, info) {
					stream.pipe(mailparser);
					UI.DownloadProgress(filesize(info.size)+' total to download.');
				});
				mailparser.on('attachment', function(attachment) {
					MailStorage.SaveAttachment(GUID, attachment);
					attachment.stream.on('data', function(chunk) {
						UI.DownloadAttachmentProgress(attachment.generatedFileName, attachment.length, chunk.length);
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
				imap.lock = false;
				UI.EndDownloadIndicator();
			});
			f.once('end', function() {
				imap.lock = false;
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
		var imap = connections[accountName];
		
		var timer = setInterval( waitLock, 5000 );
		function waitLock() {
			if( !imap.lock ) {
				imap.lock = true;
				clearInterval(timer);
				setTimeout( doConnect, 1000 ); // Having errors. See if this helps.
			} else {
				//console.log( imap.logName + ' is locked. ' + boxName + ' is waiting...' );
			}
		}
		
		function doConnect() {
			initConnect(imap, function() {
				if( boxName ) {
					imap.openBox( boxName, function(err,box) {
						if(err) {
							console.log(err);
							imap.lock=false;
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
			}, function(err) {
				console.log(err);
				imap.lock = false;
				if( onError ) onError(err);
			});
		}
	}

	function initConnect(imap, callback, onError) {
		if( imap.state == 'disconnected' ) {
			imap.connect();
			imap.once('ready', callback);
			imap.once('error', onError);
		} else {
			callback();
		}
	}
}
