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

var M3U8_EXT = ".m3u8";
var TS_EXT = ".ts";
var MD5_LENGTH = 40;
var NO_PROGRESS_TIMEOUT = 120;

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

var torrentAPI = "https://torrentapi.org/pubapi_v2.php?app_id=cbvid&";

var DB_EXT = '.db';

var streamInfo = {};

var db = {};
db.users = new nedb({ filename: __dirname + "/users" + DB_EXT, autoload: true });
db.users.persistence.setAutocompactionInterval(200000);
db.users.ensureIndex({ fieldName: 'username', unique: true });

var transcode = function (stream, hash, res) {
	var timestamp;
	streamInfo[hash].sent = false;
	fs.mkdir(dir + hash, function(err) {
	    if (err && err.code !== 'EEXIST') {
	    	console.log("Error creating folder");
	    } else {
			var command = ffmpeg(stream)
				.videoCodec('libx264')
				.audioCodec('libmp3lame')
				.size('?x720')
				.audioChannels(2)
				.addOptions([
					'-sn',
					'-async 1',
					'-b:a 128k',
					'-ar 44100',
					'-b:v 1000k',
					'-profile:v baseline',
					'-preset:v superfast',
					'-x264opts level=3.0',
					'-threads 0',
					'-flags +global_header',
					'-map 0',
					'-f segment',
					'-segment_list ' + dir + hash + "/stream" + M3U8_EXT,
					'-segment_time 10',
					'-segment_format mpegts',
					'-segment_list_flags live'
				])
				.on('start', function (cmdline) {
					//console.log(cmdline);
				})
				.on('progress', function(progress) {
					clearTimeout(timeout);
					timestamp = progress.timemark;
					if (!streamInfo[hash].sent) {
						sendPlayListFile(hash, res, function(sent) {
							if (sent) {
								//console.log("Transcoding is sufficiently along");
							}
						});
					}
					if (streamInfo[hash].lastRequest && Date.now() - streamInfo[hash].lastRequest > 30000) {
						//console.log("No recent request has been made");
						//command.kill();
					}
				})
				.on('error', function (err, stdout, stderr) {
					//console.log("Transcoding issue: " + err + stderr);
				})
				.save(dir + hash + "/" + hash + "%05d" + TS_EXT);
				
			var timeout = setTimeout(function() {
				if (!timestamp) {
					console.log("No progress has been made; killing the process.");
					res.end();
					command.kill();
				}
			}, NO_PROGRESS_TIMEOUT * 1000);
	    }
	});
};

var sendPlayListFile = function(hash, res, callback) {
	fs.access(dir + hash + "/stream" + M3U8_EXT, fs.F_OK, function(err) {
		if (!err) {
			checkPlaylistCount(fs.createReadStream(dir + hash + "/stream" + M3U8_EXT) , function(found) {
				if (found) {
					streamInfo[hash].sent = true;
					try {
						res.setHeader('Content-Type', 'application/x-mpegurl');
						withModifiedPlaylist(fs.createReadStream(dir + hash + "/stream" + M3U8_EXT), function(line) {
							res.write(line + '\n');
						}, function() {
							res.end();
							callback(true);
						});
					} catch (e) {}
				} else {
					callback(false);
				}
			});
		} else {
			callback(false);
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

function pad(num, size) {
	var s = num + "";
	while (s.length < size) s = "0" + s;
	return s;
}

app.get('/:username/:session/:magnet/:filename' + TS_EXT, function (req, res){
	var encryptedMagnet = atob(req.params.magnet);
	var magnet = decrypt(req.params.username, req.params.session, encryptedMagnet);
	var filename = req.params.filename;
	var hash = filename.substr(0, MD5_LENGTH);
	var sequenceNumber = parseInt(filename.substring(MD5_LENGTH, filename.length), 10);
	if (magnet) {
		try {
			var file = path.resolve(dir + hash + "/", filename + TS_EXT);
			send(req, file, {maxAge: '10h'})
				.on('headers', function(res, path, stat) {
					res.setHeader('Content-Type', 'video/mp2t');
				})
				.on('end', function() {
					try {
						//console.log(dir + hash + pad(sequenceNumber, filename.length - MD5_LENGTH) + TS_EXT);
						//fs.unlinkSync(dir + filename + TS_EXT);
						streamInfo[hash].lastSequence = sequenceNumber;
						streamInfo[hash].lastRequest = Date.now();
					} catch (e) { }
				})
				.pipe(res);
		} catch (e) {}
	}
});

app.get('/:username/:session/:magnet/:magnet2' + M3U8_EXT, function (req, res){
	var encryptedMagnet = atob(req.params.magnet);
	var magnet = decrypt(req.params.username, req.params.session, encryptedMagnet);
	if (magnet) {
		try {
			parseTorrent.remote(magnet, function (err, parsedTorrent) {
				if (!err) {
					magnet = parseTorrent.toMagnetURI(parsedTorrent);
					var hash = magnet.split("btih:")[1].split("&")[0];
					if (!streamInfo[hash]) {
						streamInfo[hash] = {};
					}
					sendPlayListFile(hash, res, function(sent) {
						if (!sent && !streamInfo[hash].torrenting) {
							console.log("Initializing torrent request");
							streamInfo[hash].torrenting = true;
							var engine = torrentStream(magnet, {
								verify: true,
								dht: true,
								tmp: dir
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
									transcode(largestFile.createReadStream(), hash, res);
								}
							});
						}
					});
				}
			});
		} catch (e) {
			console.log("Abandoned torrent due to an error");
		}
	}
});

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

var fetchTorrentList = function(query, socket) {
	request(torrentAPI + "get_token=get_token", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var torURL = torrentAPI + "token=" + JSON.parse(body).token + "&search_string=" + query + "&mode=search&min_seeders=5&limit=100&category=1;4;14;48;17;44;45;42;18;41&sort=seeders&format=json_extended";
			//console.log(torURL);
			request(torURL, function (error, response, body) {
				if (!error && response.statusCode == 200) {
					var results = JSON.parse(body).torrent_results;
					var final = [];
					if (results) {
						for (var i = 0; i < results.length; i++) {
							//if (results[i].category.indexOf("1080") >= 0 || results[i].category.indexOf("720") >= 0) {
								final.push({title: results[i].title, download: results[i].download});
							//}
						}
					} else {
						if (JSON.parse(body).error_code && JSON.parse(body).error_code !== 20) {
							console.log(body);
						}
					}
					socket.emit('listtorrent', final);
				}
			});
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
			console.log("Searching torrents for query: " + torReq.query);
			fetchTorrentList(torReq.query, socket);
		} else {
			socket.emit('verifyok', 'false');
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
});