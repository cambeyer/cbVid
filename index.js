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
var NO_PROGRESS_TIMEOUT = 60; //seconds
var DB_UPDATE_FREQUENCY = 5; //seconds
var DAYS_RETENTION_PERIOD = 10; //days
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

var userKeys = {};
var needingResponse = {};

var db = {};
db.users = new nedb({ filename: dir + "/users" + DB_EXT, autoload: true });
db.users.persistence.setAutocompactionInterval(200000);
db.users.ensureIndex({ fieldName: 'username', unique: true });

db.videos = new nedb({ filename: dir + "/videos" + DB_EXT, autoload: true});
db.videos.persistence.setAutocompactionInterval(200000);
db.videos.ensureIndex({ fieldName: 'hash', unique: true });

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

var cleanup = function() {
	deleteFolderRecursive(__dirname + "/torrent-stream");
	var dirs = getDirs(dir);
	for (var i = 0; i < dirs.length; i++) {
		checkRemove(dirs[i].split('/')[dirs[i].split('/').length - 1]);
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
	fs.readdirSync(path).forEach(function(file, index){
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
//if there's a folder for a video and it's in the database, but it never completed and was not terminated
var checkRemove = function(hash) {
	db.videos.find({ hash: hash }, function(err, videos) {
		if (!err && videos.length == 0) {
			try {
				console.log("Removing " + dir + hash);
				deleteFolderRecursive(dir + hash);
			} catch (e) { }
		} else if (videos.length == 1) {
			if (videos[0].torrenting || (!videos[0].terminated && (Date.now() - videos[0].timeStarted)/1000/60/60/24 > DAYS_RETENTION_PERIOD)) {
				console.log("Removing " + dir + hash + " because it was not finished or is too old");
				deleteFolderRecursive(dir + hash);
			}
		}
	});
};

var transcode = function (stream, hash, engine) {
	var lastUpdate;
	var totalDuration;
	fs.mkdir(dir + hash, function(err) {
	    if (err && err.code !== 'EEXIST') {
	    	console.log("Transcode: error creating video folder");
	    } else {
	    	var baseCommand = ffmpeg(stream)
	    		.videoCodec('libx264')
				.videoBitrate('1024k')
	    		.audioCodec('libmp3lame')
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
					'-preset:v superfast',
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
					engine.remove(false, function() {
						db.videos.update({ hash: hash }, { $set: { torrenting: false }, $unset: { remaining: 1 } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
							if (err) {
								console.log("Could not update video to terminated status");
							} else {
								io.emit('status', updatedDocs[0]);
							}
						});	
					});
				})
				.on('progress', function(progress) {
					clearTimeout(timeout);
					var now = Date.now();
					if (!lastUpdate || (now - lastUpdate) / 1000 > DB_UPDATE_FREQUENCY) {
						lastUpdate = Date.now();
						db.videos.findOne({ hash: hash }, function (err, vidEntry) {
							if (!err && vidEntry != null) {
								var secondsOfMovieProcessed = convertToSeconds(progress.timemark);
								var secondsOfTimeSpentProcessing = ((now - vidEntry.timeStarted) / 1000);
								if (totalDuration) {
									//console.log("Processed " + seconds + " of " + duration);
									var remaining = ((secondsOfTimeSpentProcessing*totalDuration)/secondsOfMovieProcessed) - secondsOfTimeSpentProcessing - totalDuration;
									//var ratio = (secondsOfTimeSpentProcessing/secondsOfMovieProcessed)*((totalDuration - secondsOfMovieProcessed) / totalDuration);
									db.videos.update({ hash: hash }, { $set: { remaining: remaining } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
										if (!err) {
											io.emit('status', updatedDocs[0]);
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
				
			var timeout = setTimeout(function() {
				console.log("No progress has been made; killing the process.");
				if (command) { command.kill(); }
				if (probeCommand) { probeCommand.kill(); }
				engine.remove(false, function() {
					deleteFolderRecursive(dir + hash);
					db.videos.update({ hash: hash }, { $set: { terminated: true, torrenting: false }, $unset: { remaining: 1 } }, { returnUpdatedDocs: true }, function (err, numAffected, updatedDocs) {
						if (err) {
							console.log("Could not update video to terminated status");
						} else {
							io.emit('status', updatedDocs[0]);
						}
					});
					for (var uniqueIdentifier in needingResponse[hash]) {
						needingResponse[hash][uniqueIdentifier].end();
						delete needingResponse[hash][uniqueIdentifier];
					}
					delete needingResponse[hash];
				});
			}, NO_PROGRESS_TIMEOUT * 1000);
	    }
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

app.get('/:username/:session/:magnet/:filename' + TS_EXT, function (req, res){
	var encryptedMagnet = atob(req.params.magnet);
	var magnet = decrypt(req.params.username, req.params.session, encryptedMagnet);
	var filename = req.params.filename;
	var hash = filename.substr(0, filename.indexOf(SEQUENCE_SEPARATOR));
	//var sequenceNumber = parseInt(filename.substring(filename.indexOf(SEQUENCE_SEPARATOR) + SEQUENCE_SEPARATOR.length, filename.length), 10);
	if (magnet) {
		try {
			var file = path.resolve(dir + hash + "/", filename + TS_EXT);
			send(req, file, {maxAge: '10h'})
				.on('headers', function(res, path, stat) {
					res.setHeader('Content-Type', 'video/mp2t');
				})
				.on('end', function() {})
				.pipe(res);
		} catch (e) {}
	}
});

var getMagnet = function(source, callback) {
	parseTorrent.remote(source, function (err, parsedTorrent) {
		callback(err, parseTorrent.toMagnetURI(parsedTorrent));
	});
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

app.get('/:username/:session/:magnet/stream' + M3U8_EXT, function (req, res){
	var encryptedMagnet = atob(req.params.magnet);
	var magnet = decrypt(req.params.username, req.params.session, encryptedMagnet);
	var uniqueIdentifier = req.params.username + req.params.session;
	if (magnet) {
		try {
			getMagnet(magnet, function(err, magnet) {
				if (!err) {
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
									db.videos.update({ hash: hash }, { $addToSet: { users: req.params.username } }, {}, function () {});
									trySendPlayListFile(hash, uniqueIdentifier);
								}
							} else {
								//first time this has been requested
								startTorrent(hash, magnet, req.params.username);
							}
						}
					});
				}
			});
		} catch (e) {
			console.log("Abandoned torrent due to an error");
		}
	}
});

var startTorrent = function(hash, magnet, username) {
	var users = [];
	users.push(username);
	db.videos.insert({ hash: hash, title: decodeURIComponent(magnet.split("&dn=")[1].split("&")[0]), users: users, torrenting: true, terminated: false, timeStarted: Date.now(), remaining: INITIAL_REMAINING_ESTIMATE }, function (err, newDoc) {
		if (!err) {
			io.emit('status', newDoc);
			console.log("Initializing torrent request");
			var engine = torrentStream(magnet, {
				verify: true,
				dht: true,
				tmp: __dirname
			});
			engine.on('ready', function() {
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
		} else {
			console.log("Could not insert initial video record");
		}
	});
};

var createSRPResponse = function (socket, user) {
	var srpServer = new jsrp.server();
	srpServer.init({ salt: user.salt, verifier: user.verifier }, function () {
		srpServer.setClientPublicKey(user.publicKey);
		var srpMsg = {};
		srpMsg.salt = srpServer.getSalt();
		srpMsg.publicKey = srpServer.getPublicKey();
		var sessionNumber = Date.now().toString();
		if (!userKeys[user.username]) {
			userKeys[user.username] = {keys: []};
		}
		var key = {};
		key.content = srpServer.getSharedKey();
		key.sessionNumber = sessionNumber;
		key.verified = false;
		userKeys[user.username].keys.push(key);
		srpMsg.encryptedPhrase = encrypt(user.username, sessionNumber, sessionNumber, true);
		socket.emit('login', srpMsg);
	});
};

var getKey = function (username, sessionNumber) {
	var key;
	if (userKeys[username]) {
		for (var i = 0; i < userKeys[username].keys.length; i++) {
			if (userKeys[username].keys[i].sessionNumber < Date.now() - 86400000) { //24 hour timeout
				userKeys[username].keys.splice(i, 1);
				i--;
				continue;
			}
			if (!key && userKeys[username].keys[i].sessionNumber == sessionNumber) {
				key = userKeys[username].keys[i];
			}
		}
	}
	return key;
};

var decrypt = function (username, sessionNumber, text, disregardVerification) {
	var key = getKey(username, sessionNumber);
	if (key) {
		try {
			if (disregardVerification || key.verified) {
				return CryptoJS.AES.decrypt(text, key.content).toString(CryptoJS.enc.Utf8);
			}
		} catch (e) { }
	}
};

var encryptedPhrases = {};

var encrypt = function(username, sessionNumber, text, disregardVerification) {
	var key = getKey(username, sessionNumber);
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
				return encryptedPhrases[username][sessionNumber][text];
			}
		} catch (e) { }
	}
};

var lookupByMagnet = function(magnet, callback) {
	getMagnet(magnet, function(err, magnet) {
		if (!err) {
			var hash = getHash(magnet);
			db.videos.findOne({ hash: hash }, { timeStarted: 0, _id: 0 }, function(err, vidEntry) {
				if (!err) {
					callback(vidEntry);
				}
			});
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
	lookupByMagnet(list[pos].magnet, function(vidEntry) {
		if (vidEntry) {
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

//https://rarbg.to/torrents.php?category=18;41&search=better+call+saul&order=seeders&by=DESC

var fetchTorrentList = function(query, socket) {
	request(torrentAPI + "get_token=get_token", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var torURL = torrentAPI + "token=" + JSON.parse(body).token + "&search_string=" + query + "&mode=search&min_seeders=5&limit=100&category=1;14;48;17;44;45;42;18;41&sort=seeders&format=json_extended";
			//console.log(torURL);
			request(torURL, function (error, response, body) {
				if (!error && response.statusCode == 200) {
					var results = JSON.parse(body).torrent_results;
					var final = [];
					if (results) {
						for (var i = 0; i < results.length; i++) {
							final.push({title: results[i].title, magnet: results[i].download, hash: getHash(results[i].download) });
						}
					} else {
						if (JSON.parse(body).error_code && JSON.parse(body).error_code !== 20) {
							console.log(body);
						}
					}
					addTorrentStatus(final, function() {
						socket.emit('listtorrent', final);
					});
				}
			});
		} else {
			console.log("Torrent search error: " + error);
		}
	});
};

var sendMyView = function(username, socket) {
	console.log("Sending view for: " + username);
	db.videos.find({ users: username }, { _id: 0, users: 0, timeStarted: 0 }, function(err, videos) {
		if (!err) {
			for (var i = 0; i < videos.length; i++) {
				videos[i].magnet = videos[i].hash;
			}
			socket.emit('listtorrent', videos);
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
		if (decrypt(challenge.username, challenge.session, challenge.encryptedPhrase, true) == "client") {
			console.log("Successfully logged in user: " + challenge.username);
			getKey(challenge.username, challenge.session).verified = true;
			socket.emit('verifyok', 'true');
		} else {
			console.log("Failed login for user: " + challenge.username);
			socket.emit('verifyok', 'false');
		}
	});
	socket.on('listtorrent', function(torReq) {
		if (decrypt(torReq.username, torReq.session, torReq.encryptedPhrase) == "listtorrent") {
			if (torReq.query) {
				console.log("Searching torrents for query: " + torReq.query);
				fetchTorrentList(torReq.query, socket);
			}
		} else {
			socket.emit('verifyok', 'false');
		}
	});
	socket.on('myview', function(viewReq) {
		if (decrypt(viewReq.username, viewReq.session, viewReq.encryptedPhrase) == "myview") {
			sendMyView(viewReq.username, socket);	
		}
	});
	socket.on('logout', function (logoutReq) {
		if (decrypt(logoutReq.username, logoutReq.session, logoutReq.verification, true) == "logout") {
			for (var i = 0; i < userKeys[logoutReq.username].keys.length; i++) {
				if (userKeys[logoutReq.username].keys[i].sessionNumber == logoutReq.session) {
					userKeys[logoutReq.username].keys.splice(i, 1);
					var resp = {};
					resp.username = logoutReq.username;
					resp.session = logoutReq.session;
					io.emit('logout', resp);
					console.log("Successfully logged out user: " + logoutReq.username);
					break;
				}
			}
		}
	});
});

http.listen(80, "0.0.0.0", function (){
	console.log('listening on *:80');
	cleanup();
});