var express = require('express');
var app = express();
var busboy = require('connect-busboy');
var path = require('path');
var readLine = require('readline');
var fs = require('fs-extra');
var http = require('http').Server(app);
var send = require('send');
var request = require('request');
var io = require('socket.io')(http);
var parseTorrent = require('parse-torrent');
var torrentStream = require('torrent-stream');
var kickass = require('kickass-so');
var node_cryptojs = require('node-cryptojs-aes');
var CryptoJS = node_cryptojs.CryptoJS;
var ffmpeg = require('fluent-ffmpeg');
var nedb = require('nedb');
var jsrp = require('jsrp');
var atob = require('atob');

var torrentAPI = "https://torrentapi.org/pubapi_v2.php?app_id=cbvid&";

var DB_EXT = '.db';

var M3U8_EXT = ".m3u8";
var TS_EXT = ".ts";
var SEQUENCE_SEPARATOR = "_";
var NO_PROGRESS_INITIAL_TIMEOUT = 60; //seconds
var NO_PROGRESS_RECURRING_TIMEOUT = 60 * 60; //seconds
var MAX_MAGNET_RETRIES = 3;
var MAGNET_RETRY_DELAY = 500; //milliseconds
var DB_UPDATE_FREQUENCY = 5; //seconds
var DAYS_RETENTION_PERIOD = 20; //days
var INITIAL_REMAINING_ESTIMATE = 86400; //seconds

//set the directory where files are served from and uploaded to
var dir = __dirname + '/files/';
//ensure the directory exists
fs.mkdir(dir, function(err) {
    if (err && err.code !== 'EEXIST') {
    	console.log("Error creating folder");
    }
});

app.use(busboy());

app.use(function (req, res, next) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET');
	res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Range');
	res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
	next();
});

//files in the public directory can be directly queried for via HTTP
app.use(express.static(path.join(__dirname, 'public')));

var needingResponse = {};

var db = {};
db.users = new nedb({ filename: dir + "/users" + DB_EXT, autoload: true });
db.users.persistence.setAutocompactionInterval(200000);
db.users.ensureIndex({ fieldName: 'username', unique: true });

db.videos = new nedb({ filename: dir + "/videos" + DB_EXT, autoload: true, timestampData: true });
db.videos.persistence.setAutocompactionInterval(200000);
db.videos.ensureIndex({ fieldName: 'hash', unique: true });
db.videos.ensureIndex({ fieldName: 'updatedAt', expireAfterSeconds: DAYS_RETENTION_PERIOD*24*60*60 }); //remove entries after the retention period has expired

var startup = function() {
	db.users.update({ }, { $set: { keys: [] } }, { multi: true }, function () { //remove to let users remain logged in across server restarts... then we have to broadcast deletes below
		deleteFolderRecursive(__dirname + "/torrent-stream");
		cleanup(true);
	});
};

var getDirs = function (dir) {
    var dirs = [];
    var contents = fs.readdirSync(dir);
    for (var i in contents) {
        var name = dir + '/' + contents[i];
        if (fs.statSync(name).isDirectory()) {
            dirs.push(name);
        }
    }
    return dirs;
};

var cleanup = function(startup) {
	var dirs = getDirs(dir);
	for (var i = 0; i < dirs.length; i++) {
		checkRemove(dirs[i].split('/')[dirs[i].split('/').length - 1], startup);
	}
	//if there's an entry in the database that shows the video as not terminated but there's no folder for it
	db.videos.find({ }, function(err, videos) {
		if (!err) {
			for (var i = 0; i < videos.length; i++) {
				if (videos[i].hash && !videos[i].terminated) {
					try {
						fs.statSync(dir + videos[i].hash);
					} catch (e) {
						db.videos.remove({ hash: videos[i].hash }, {}, function(err, numRemoved) {
							if (!err) {
								console.log("Removed " + numRemoved + " abandoned records.");
							}
						});
					}
				}
			}
		}
	});
};

var deleteFolderRecursive = function(path) {
	if (fs.existsSync(path)) {
		fs.readdirSync(path).forEach(function(file, index) {
			var curPath = path + "/" + file;
			if(fs.lstatSync(curPath).isDirectory()) {
				deleteFolderRecursive(curPath);
			} else {
				fs.unlinkSync(curPath);
			}
		});
		fs.rmdirSync(path);
	}
};

//if there's a folder for a video but it's not in the database
//if there's a folder for a video and it's in the database, but it never completed and was not terminated [ONLY ON STARTUP]
var checkRemove = function(hash, startup) {
	db.videos.find({ hash: hash }, function(err, videos) {
		if (!err && videos.length == 0) {
			try {
				console.log("Removing " + dir + hash + " because it is not in the videos database");
				deleteFolderRecursive(dir + hash);
			} catch (e) { }
		} else if (startup && videos.length == 1 && videos[0].torrenting) {
				console.log("Removing " + dir + hash + " because it was not finished");
				deleteFolderRecursive(dir + hash);
		}
	});
};

var transcode = function (stream, hash, engine) {
	var lastUpdate;
	var totalDuration;
	var timeout;
	fs.mkdir(dir + hash, function(err) {
	    if (err && err.code !== 'EEXIST') {
	    	console.log("Transcode: error creating video folder");
	    } else {
	    	cleanup();
	    	var baseCommand = ffmpeg(stream)
	    		.videoCodec('libx264')
				.videoBitrate('1024k')
	    		.audioCodec('aac')
	    		.audioBitrate('128k')
	    		.size('?x720')
	    		.fps(30)
	    		.audioChannels(2)
	    		.outputOption('-analyzeduration 2147483647')
				.outputOption('-probesize 2147483647')
				.outputOption('-pix_fmt yuv420p');
	    	
	    	var testFile = dir + hash + "/test.mp4";
	    	var probeCommand = baseCommand.clone()
				.format('mp4')
				.duration("0.001")
				.on('end', function(stdout, stderr) {
					try {
						fs.unlinkSync(testFile);
		    			totalDuration = convertToSeconds(stderr.split("Duration: ")[1].split(",")[0]);
					} catch (e) {
						console.log("Error parsing duration from test file");
					}
	    		})
	    		.on('error', function (err, stdout, stderr) {
					console.log("Probe transcoding issue: " + err);
					console.log(stderr);
				})
	    		.save(testFile);
	    	
	    	var command = baseCommand.clone()
				.addOptions([
					'-sn',
					'-async 1',
					'-ar 44100',
					'-pix_fmt yuv420p',
					'-profile:v baseline',
					'-preset:v superfast', //ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, very slow
					'-x264opts level=3.0',
					'-threads 0',
					'-flags +global_header',
					//'-map 0',
					'-map 0:v:0',
					'-map 0:a:0',
					'-analyzeduration 2147483647',
					'-probesize 2147483647',
					'-f segment',
					'-segment_list ' + dir + hash + "/stream" + M3U8_EXT,
					'-segment_time 10',
					'-segment_format mpegts',
					'-segment_list_flags live'
				])
				.on('start', function (cmdline) {
					//console.log(cmdline);
				})
				.on('end', function() {
					clearTimeout(timeout);
					engine.remove(false, function() {
						db.videos.update({ hash: hash }, { $set: { torrenting: false }, $unset: { remaining: 1 } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
							if (err) {
								console.log("Could not update video to non-torrenting status");
							} else {
								delete updatedDocs.users;
								io.emit('status', updatedDocs);
							}
						});	
					});
				})
				.on('progress', function(progress) {
					clearTimeout(timeout);
					timeout = setTimeout(function() { killProgress("No progress has been made in an hour; killing the process", hash, command, probeCommand, engine); }, NO_PROGRESS_RECURRING_TIMEOUT * 1000);
					var now = Date.now();
					if (!lastUpdate || (now - lastUpdate) / 1000 > DB_UPDATE_FREQUENCY) {
						lastUpdate = Date.now();
						db.videos.findOne({ hash: hash }, function (err, vidEntry) {
							if (!err && vidEntry != null) {
								var secondsOfMovieProcessed = convertToSeconds(progress.timemark);
								var secondsOfTimeSpentProcessing = ((now - vidEntry.createdAt) / 1000);
								if (totalDuration) {
									//console.log("Processed " + seconds + " of " + duration);
									var remaining = ((secondsOfTimeSpentProcessing*totalDuration)/secondsOfMovieProcessed) - secondsOfTimeSpentProcessing - totalDuration;
									//var ratio = (secondsOfTimeSpentProcessing/secondsOfMovieProcessed)*((totalDuration - secondsOfMovieProcessed) / totalDuration);
									db.videos.update({ hash: hash }, { $set: { remaining: remaining } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
										if (!err) {
											delete updatedDocs.users;
											io.emit('status', updatedDocs);
										} else {
											console.log("Transcode: could not update video ratio");
										}
									});
								}
							}
						});
					}
					if (needingResponse[hash]) {
						for (var uniqueIdentifier in needingResponse[hash]) {
							trySendPlayListFile(hash, uniqueIdentifier);
						}
					}
				})
				.on('error', function (err, stdout, stderr) {
					console.log("Transcoding issue: " + err);
					console.log(stderr);
				})
				.save(dir + hash + "/" + hash + SEQUENCE_SEPARATOR + "%05d" + TS_EXT);
				
			timeout = setTimeout(function() { killProgress("No initial progress has been made; killing the process", hash, command, probeCommand, engine); }, NO_PROGRESS_INITIAL_TIMEOUT * 1000);
	    }
	});
};

var killProgress = function(message, hash, command, probeCommand, engine) {
	console.log(message);
	if (command) { command.kill(); }
	if (probeCommand) { probeCommand.kill(); }
	engine.remove(false, function() {
		deleteFolderRecursive(dir + hash);
		db.videos.update({ hash: hash }, { $set: { terminated: true, torrenting: false }, $unset: { remaining: 1 } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
			if (err) {
				console.log("Could not update video to terminated status");
			} else {
				delete updatedDocs.users;
				io.emit('status', updatedDocs);
			}
		});
		for (var uniqueIdentifier in needingResponse[hash]) {
			needingResponse[hash][uniqueIdentifier].end();
			delete needingResponse[hash][uniqueIdentifier];
		}
		delete needingResponse[hash];
	});
};

var convertToSeconds = function(timemark) {
	var tt = timemark.split(":");
	return tt[0]*3600 + tt[1]*60 + tt[2]*1;
};

var trySendPlayListFile = function(hash, uniqueIdentifier) {
	var filename = dir + hash + "/stream" + M3U8_EXT;
	fs.access(filename, fs.F_OK, function(err) {
		if (!err) {
			checkPlaylistCount(fs.createReadStream(filename) , function(found) {
				if (found) {
					try {
						var res = needingResponse[hash][uniqueIdentifier];
						if (!res.handled) {
							res.handled = true;
							res.setHeader('Content-Type', 'application/x-mpegurl');
							withModifiedPlaylist(fs.createReadStream(filename), function(line) {
								res.write(line + '\n');
							}, function() {
								res.end();
								delete needingResponse[hash][uniqueIdentifier];
								if (Object.keys(needingResponse[hash]).length == 0) {
									delete needingResponse[hash];
								}
							});
						}
					} catch (e) {}
				}
			});
		}
	});
};

function withModifiedPlaylist(readStream, eachLine, done) {
	var rl = readLine.createInterface({terminal: false, input: readStream});
	var foundPlaylistType = false;
	rl.on('line', function (line) {
		if (line.match('^#EXT-X-PLAYLIST-TYPE:')) foundPlaylistType = true;
		else if (line.match('^#EXTINF:') && !foundPlaylistType) {
			eachLine('#EXT-X-PLAYLIST-TYPE:EVENT');
			foundPlaylistType = true;
		}
		eachLine(line);
	});
	rl.on('close', function() {
		done();
	});
}

function checkPlaylistCount(stream, cb) {
	var rl = readLine.createInterface({terminal: false, input: stream});
	var count = 0;
	var need = 3;
	var found = false;
	rl.on('line', function (line) {
		if (line.match('^#EXTINF:[0-9]+')) count++;
		if (count >= need) {
			found = true;
			rl.close();
		}
	});
	rl.on('close', function() {
		cb(found);
	});
}

app.get('/:username/:session/:magnet/:sequence/:filename' + TS_EXT, function (req, res){
	decrypt(req.params.username, req.params.session, atob(req.params.sequence), false, function(sequenceNumber) {
		//if (sequenceNumber) { //do some authorization that the sequence number went up for that session
			decrypt(req.params.username, req.params.session, atob(req.params.magnet), false, function(magnet) {
				var filename = req.params.filename;
				var hash = filename.substr(0, filename.indexOf(SEQUENCE_SEPARATOR));
				//var sequenceNumber = parseInt(filename.substring(filename.indexOf(SEQUENCE_SEPARATOR) + SEQUENCE_SEPARATOR.length, filename.length), 10);
				if (magnet) {
					try {
						var file = path.resolve(dir + hash + "/", filename + TS_EXT);
						send(req, file, {maxAge: '10h'})
							.on('headers', function(res) {
								res.setHeader('Content-Type', 'video/mp2t');
							})
							.on('end', function() {})
							.pipe(res);
					} catch (e) {}
				}
			});
		//} else {
		//	res.sendStatus(401);
		//}
	});
});

var getMagnet = function(source, callback, num) {
	if (!num || num < MAX_MAGNET_RETRIES) {
		parseTorrent.remote(source, function (err, parsedTorrent) {
			if (err) {
				//console.log("Error getting manget: " + err);
				setTimeout(function() {
					getMagnet(source, callback, num ? num + 1 : 1);
				}, MAGNET_RETRY_DELAY);
			} else {
				callback(parseTorrent.toMagnetURI(parsedTorrent));
			}
		});
	} else {
		console.log("Maximum retries exceeded; cannot fetch magnet");
	}
};

var getHash = function(magnet) {
	var hash;
	try {
		hash = magnet.split("btih:")[1].split("&")[0];
	} catch (e) {}
	if (!hash) {
		return magnet;
	} else {
		return hash;
	}
};

var getTitle = function(magnet) {
	var title;
	try {
		title = magnet.split("&dn=")[1].split("&")[0].replace(/\+/g, '%20');
		title = decodeURIComponent(title);
	} catch (e) {}
	if (!title) {
		return "";
	} else {
		return title;
	}
};

var broadcastAccess = function(hash, username, callback) {
	db.videos.findOne({ hash: hash }, function(err, vidEntry) {
		if (!err && vidEntry) {
			var modified = true;
			for (var i = 0; i < vidEntry.users.length; i++) {
				if (vidEntry.users[i] == username) {
					modified = false;
					break;
				}
			}
			if (modified) {
				delete vidEntry.users;
				vidEntry.magnet = vidEntry.hash;
				sendMessageToUser(username, {type: 'add', payload: vidEntry});
			}
			db.videos.update({ hash: hash }, { $addToSet: { users: username } }, { returnUpdatedDocs: true }, function (err, numAffected, vidEntries) {
				if (!err && numAffected) {
					callback(vidEntries);
				}
			});
		} else {
			callback();
		}
	});

};

var broadcastRemoval = function(hash, username, callback) {
	db.videos.findOne({ hash: hash }, function(err, vidEntry) {
		if (!err && vidEntry) {
			var modified = false;
			for (var i = 0; i < vidEntry.users.length; i++) {
				if (vidEntry.users[i] == username) {
					modified = true;
					break;
				}
			}
			if (modified) {
				db.videos.update({ hash: hash }, { $pull: { users: username } }, { returnUpdatedDocs: true }, function (err, numAffected, vidEntries) {
					if (!err && numAffected) {
						delete vidEntry.users;
						vidEntry.magnet = vidEntry.hash;
						sendMessageToUser(username, {type: 'remove', payload: vidEntry});
						callback(vidEntries);
					}
				});
			} else {
				callback(vidEntry);
			}
		} else {
			callback();
		}
	});

};

app.get('/:username/:session/:magnet/:stream' + M3U8_EXT, function (req, res){
	decrypt(req.params.username, req.params.session, atob(req.params.magnet), false, function(magnet) {
		var uniqueIdentifier = req.params.username + req.params.session;
		if (magnet) {
			try {
				getMagnet(magnet, function(magnet) {
					var hash = getHash(magnet);
					if (!needingResponse[hash]) {
						needingResponse[hash] = {};
					}
					needingResponse[hash][uniqueIdentifier] = res;
					db.videos.findOne({ hash: hash }, function (err, vidEntry) {
						if (!err) {
							if (vidEntry) {
								if (vidEntry.terminated) {
									db.videos.remove({ hash: hash }, {}, function(err, numRemoved) {
										if (!err && numRemoved == 1) {
											startTorrent(hash, magnet, req.params.username);
										} else {
											console.log("Could not remove terminated entry");
										}
									});
								} else {
									//entry already exists so try to fulfill the request straightaway
									broadcastAccess(hash, req.params.username, function() {
										delete vidEntry.users;
										io.emit('status', vidEntry);
										trySendPlayListFile(hash, uniqueIdentifier);
									});
								}
							} else {
								//first time this has been requested
								startTorrent(hash, magnet, req.params.username);
							}
						}
					});
				});
			} catch (e) {
				console.log("Abandoned torrent due to an error");
			}
		}
	});
});

var startTorrent = function(hash, magnet, username) {
	db.videos.insert({ hash: hash, title: getTitle(magnet), users: [], torrenting: true, terminated: false, remaining: INITIAL_REMAINING_ESTIMATE }, function (err, newDoc) {
		if (!err) {
			broadcastAccess(hash, username, function(newDoc) {
				delete newDoc.users;
				io.emit('status', newDoc);
				console.log("Initializing torrent request");
				var engine = torrentStream(magnet, {
					verify: true,
					dht: true,
					tmp: __dirname
				});
				var timeout = setTimeout(function() { killProgress("Torrent engine cannot start; killing.", hash, null, null, engine); }, NO_PROGRESS_INITIAL_TIMEOUT * 1000);
				engine.on('ready', function() {
					clearTimeout(timeout);
					if (engine.files.length > 0) {
						var largestFile = engine.files[0];
						for (var i = 1; i < engine.files.length; i++) {
							if (engine.files[i].length > largestFile.length) {
								largestFile = engine.files[i];
							}
						}
						console.log("Torrenting file: " + largestFile.name + ", size: " + largestFile.length);
						transcode(largestFile.createReadStream(), hash, engine);
					}
				});
			});
		} else {
			console.log("Could not insert initial video record");
		}
	});
};

var createSRPResponse = function (socket, user) {
	var srpServer = new jsrp.server();
	srpServer.init({ salt: user.salt, verifier: user.verifier }, function () {
		srpServer.setClientPublicKey(user.publicKey);
		var sessionNumber = Date.now().toString();
		db.users.update({ username: user.username }, { $push: { keys: { content: srpServer.getSharedKey(), sessionNumber: sessionNumber, verified: false } } }, {}, function () {
			encrypt(user.username, sessionNumber, sessionNumber, true, function(encryptedPhrase) {
				socket.emit('login', { salt: srpServer.getSalt(), publicKey: srpServer.getPublicKey(), encryptedPhrase: encryptedPhrase });
			});
		});
	});
};

var getKey = function (username, sessionNumber, callback) {
	db.users.findOne({ username: username }, function(err, userObj) {
		if (!err && userObj) {
			var key;
			var modified = false;
			for (var i = 0; i < userObj.keys.length; i++) {
				if (userObj.keys[i].sessionNumber < Date.now() - 86400000) { //24 hour timeout
					userObj.keys.splice(i, 1);
					i--;
					modified = true;
					continue;
				}
				if (!key && userObj.keys[i].sessionNumber == sessionNumber) {
					key = userObj.keys[i];
				}
			}
			if (modified) {
				db.users.update({ username: username }, { $set: { keys: userObj.keys } }, {}, function(err, numReplaced) {
					if (!err) {
						callback(key);
					}
				});
			} else {
				callback(key);
			}
		} else {
			callback();
		}
	});
};

var decrypt = function (username, sessionNumber, text, disregardVerification, callback) {
	getKey(username, sessionNumber, function(key) {
		if (key) {
			try {
				if (disregardVerification || key.verified) {
					callback(CryptoJS.AES.decrypt(text, key.content).toString(CryptoJS.enc.Utf8));
				}
			} catch (e) { }
		} else {
			callback();
		}
	});
};

var encryptedPhrases = {};

var encrypt = function(username, sessionNumber, text, disregardVerification, callback) {
	getKey(username, sessionNumber, function(key) {
		if (key) {
			try {
				if (disregardVerification || key.verified) {
					if (!encryptedPhrases[username]) {
						encryptedPhrases[username] = {};
					}
					if (!encryptedPhrases[username][sessionNumber]) {
						encryptedPhrases[username][sessionNumber] = {};
					}
					if (!encryptedPhrases[username][sessionNumber][text]) {
						encryptedPhrases[username][sessionNumber][text] = CryptoJS.AES.encrypt(text, key.content).toString();
					}
					callback(encryptedPhrases[username][sessionNumber][text]);
				}
			} catch (e) { }
		} else {
			callback();
		}
	});
};

var addTorrentStatus = function(list, callback) {
	var count = 0;
	for (var i = 0; i < list.length; i++) {
		processStatus(list, i, function() {
			count++;
			if (count == list.length) {
				callback();
			}
		});
	}
};

var processStatus = function(list, pos, callback) {
	db.videos.findOne({ hash: list[pos].hash }, { createdAt: 0, updatedAt: 0, _id: 0 }, function(err, vidEntry) {
		if (!err && vidEntry) {
			var title = String(list[pos].title);
			var magnet = String(list[pos].magnet);
			list[pos] = vidEntry;
			list[pos].title = title;
			list[pos].magnet = magnet;
			delete vidEntry.users;
		}
		callback();
	});
};

var fetchTorrentList = function(query, socket) {
	request(torrentAPI + "get_token=get_token", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var torURL = torrentAPI + "token=" + JSON.parse(body).token + "&search_string=" + query + "&mode=search&min_seeders=5&limit=100&category=1;14;48;17;44;45;42;18;41&sort=seeders&format=json_extended";
			request(torURL, function (error, response, body) {
				var final = [];
				if (!error && response.statusCode == 200) {
					var results = JSON.parse(body).torrent_results;
					if (results) {
						for (var i = 0; i < results.length; i++) {
							final.push({title: results[i].title, magnet: results[i].download, hash: getHash(results[i].download) });
						}
					}
				}
				kickass({
					search: query,
					field: 'seeders',
					sorder: 'desc'},
				function (err, results) {
					if (!err && results) {
						for (var i = 0; i < results.list.length; i++) {
							var category = results.list[i].category;
							if ((category == "TV" || category == "Movies") && results.list[i].seeds > 5) {
								var resHash = results.list[i].hash.toLowerCase();
								for (var j = 0; j < final.length; j++) {
									if (final[j].hash == resHash) {
										final.splice(j, 1);
										break;
									}
								}
								final.push({title: results.list[i].title.replace(/\&amp;/g,'&'), magnet: results.list[i].torrentLink, hash: resHash});
							}
						}
					}
					addTorrentStatus(final, function() {
						socket.emit('listtorrent', final);
					});
				});
			});
		}
	});
};

var sendMyView = function(username, socket) {
	console.log("Sending view for: " + username);
	db.videos.find({ users: username, terminated: false }, { _id: 0, users: 0, createdAt: 0, updatedAt: 0 }, function(err, videos) {
		if (!err) {
			for (var i = 0; i < videos.length; i++) {
				videos[i].magnet = videos[i].hash;
			}
			socket.emit('listtorrent', videos);
		}
	});
};

var sendOne = function(username, sessionNumber, message) {
	encrypt(username, sessionNumber, JSON.stringify(message), false, function(encryptedMessage) {
		io.emit('broadcast', { username: username, sessionNumber: sessionNumber, message: encryptedMessage });
	});
};

var sendMessageToUser = function(username, message) {
	db.users.findOne({ username: username }, { "_id": 0 }, function(err, userObj) {
		if (!err) {
			for (var i = 0; i < userObj.keys.length; i++) {
				sendOne(username, userObj.keys[i].sessionNumber, message);
			}
		}
	});
};

io.on('connection', function (socket) {
	socket.disconnected = false;
	socket.on('disconnect', function () {
		socket.disconnected = true;
	});
	socket.on('new', function (newUser) {
		var userObj = {};
		userObj.username = newUser.username;
		userObj.salt = newUser.salt;
		userObj.verifier = newUser.verifier;
		userObj.keys = [];
		db.users.insert(userObj, function (err) {
			if (!err) {
				console.log("Registered new user: " + newUser.username);
				userObj.publicKey = newUser.publicKey;
				createSRPResponse(socket, userObj);
			} else {
				console.log("DB insert error");
			}
		});
	});
	socket.on('login', function (srpObj) {
		db.users.findOne({ username: srpObj.username }, function (err, userObj) {
			if (!err) {
				if (!userObj) {
					socket.emit('new');
				} else {
					userObj.publicKey = srpObj.publicKey;
					createSRPResponse(socket, userObj);
				}
			} else {
				console.log("DB lookup error");
			}
		});
	});
	socket.on('verify', function (challenge) {
		decrypt(challenge.username, challenge.session, challenge.encryptedPhrase, true, function(encryptedPhrase) {
			if (encryptedPhrase == "client") {
				console.log("Successfully logged in user: " + challenge.username);
				db.users.findOne({ username: challenge.username }, function(err, userObj) {
					if (!err && userObj) {
						var modified = false;
						for (var i = 0; i < userObj.keys.length; i++) {
							if (userObj.keys[i].sessionNumber == challenge.session && !userObj.keys[i].verified) {
								userObj.keys[i].verified = true;
								modified = true;
								break;
							}
						}
						if (modified) {
							db.users.update({ username: challenge.username }, { $set: { keys: userObj.keys } }, {}, function() {});
						}
						socket.emit('verifyok', 'true');
					}
				});
			} else {
				console.log("Failed login for user: " + challenge.username);
				socket.emit('verifyok', 'false');
			}
		});
	});
	socket.on('listtorrent', function(torReq) {
		decrypt(torReq.username, torReq.session, torReq.encryptedPhrase, false, function(encryptedPhrase) {
			if (encryptedPhrase == "listtorrent") {
				if (torReq.query) {
					console.log("Searching torrents for query: " + torReq.query);
					fetchTorrentList(torReq.query, socket);
				}
			} else {
				socket.emit('verifyok', 'false');
			}
		});
	});
	socket.on('myview', function(viewReq) {
		decrypt(viewReq.username, viewReq.session, viewReq.encryptedPhrase, false, function(encryptedPhrase) {
			if (encryptedPhrase == "myview") {
				sendMyView(viewReq.username, socket);
			} else {
				socket.emit('verifyok', 'false');
			}
		});
	});
	socket.on('remove', function(remReq) {
		decrypt(remReq.username, remReq.session, remReq.encryptedPhrase, false, function(encryptedPhrase) {
			if (encryptedPhrase == "remove") {
				broadcastRemoval(remReq.hash, remReq.username, function(vidEntry) {
					console.log("User " + remReq.username + " removed torrent " + vidEntry.title);
				});
			}
		});
	});
	socket.on('logout', function (logoutReq) {
		decrypt(logoutReq.username, logoutReq.session, logoutReq.verification, true, function(encryptedPhrase) {
			if (encryptedPhrase == "logout") {
				db.users.findOne({ username: logoutReq.username }, function(err, userObj) {
					if (!err && userObj) {
						var modified = false;
						for (var i = 0; i < userObj.keys.length; i++) {
							if (userObj.keys[i].sessionNumber == logoutReq.session) {
								userObj.keys.splice(i, 1);
								modified = true;
								break;
							}
						}
						if (modified) {
							db.users.update({ username: logoutReq.username }, { $set: { keys: userObj.keys } }, {}, function() {});
						}
						io.emit('logout', { username: logoutReq.username, session: logoutReq.session });
						console.log("Successfully logged out user: " + logoutReq.username);
					}
				});
			}
		});
	});
});

http.listen(80, "0.0.0.0", function (){
	console.log('listening on *:80');
	startup();
});