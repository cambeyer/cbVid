/*global angular*/
angular.module('cbVidApp', ['ngAnimate', 'ui.router', 'ngStorage', 'ui.bootstrap'])

.config(function($stateProvider, $urlRouterProvider) {
    $stateProvider
        .state('auth', {
            url: '/auth',
            templateUrl: 'auth.html',
            controller: 'authController'
        })
        
        .state('embed', {
        	url: '/embed/:filename',
        	controller: function($rootScope, $state, $stateParams) {
        		if ($rootScope.canEmbed) {
	        		$rootScope.embed = true;
	        		$rootScope.canEmbed = false;
	        		$state.go('cbvid.list', {filename: $stateParams.filename});
        		}
        	}
        })

        .state('cbvid', {
            templateUrl: 'cbvid.html',
			controller: 'containerController'
        })

        .state('cbvid.home', {
        	url: '/videos/',
        	templateUrl: 'home.html',
        	controller: 'homeController',
			resolve: {
				videos: function(VideoList, $rootScope, UserObj, EncryptService) {
					$rootScope.socket.emit('list', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('list') }));
					return VideoList.getList();
				}
			}
        })

		.state('cbvid.list', {
			url: '/videos/:filename',
			templateUrl: 'list.html',
			controller: 'listController',
			resolve: {
				videos: function(VideoList, $rootScope, $stateParams, UserObj, EncryptService) {
					$rootScope.params = $stateParams;
					$rootScope.socket.emit('list', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('list') }));
					return VideoList.getList();
				}
			}
		})

		.state('cbvid.list.player', {
			templateUrl: 'player.html',
			controller: 'playerController'
		});

    $urlRouterProvider.otherwise('/auth');
})

.run(function($rootScope, $localStorage, $state, EncryptService, UserObj, VideoList) {
	$rootScope.$storage = $localStorage;
	$rootScope.$storage.authed;
	$rootScope.title;
	/*global io*/
	$rootScope.socket = io();
	$rootScope.pendingState;
	$rootScope.pendingParameters;
	$rootScope.search = {
		text: ''
	};
	
	$rootScope.embed = false;
	$rootScope.canEmbed = true;

	$rootScope.uploading = {};
	$rootScope.processing = {};
	$rootScope.procuring = {};

	$rootScope.torrentList = [];
	$rootScope.staleQuery = "";

	$rootScope.setTitle = function(title) {
		$rootScope.title = title + " - cbVid";
	};

	$rootScope.socket.on('reconnect', function (num) {
		$rootScope.$apply(function () {
			$rootScope.verify();
		});
	});

	$rootScope.sendSubscriptions = function() {
		for (var md5 in $rootScope.processing) {
			$rootScope.socket.emit('subscribe', md5);
		}
		for (var md5 in $rootScope.procuring) {
			$rootScope.socket.emit('subscribe', md5);
		}
	};

	$rootScope.verify = function() {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			console.log("Verifying");
			$rootScope.socket.emit('verify', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('client') }));
		}
	};

	$rootScope.socket.on('verifyok', function(successBool) {
		$rootScope.$storage.authed = successBool !== 'false';
		if (!$rootScope.$storage.authed) {
			//alert("Your session has expired.  Please log in again.");
			$localStorage.$reset({
				username: $rootScope.$storage.username
			});
			EncryptService.reset();
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$state.reload();
		} else {
			$rootScope.sendSubscriptions();
			if ($state.current.name == 'auth') {
				$state.go('cbvid.list');
			}
		}
	});

	$rootScope.$watch(function () {return $rootScope.$storage.sessionNumber}, function (newValue, oldValue) {
		if (newValue !== oldValue) {
			if (newValue && !oldValue) {
				$rootScope.verify();
			} else if (oldValue && !newValue) {
				VideoList.reset();
				EncryptService.reset();
				$rootScope.search.text = '';
				$rootScope.staleQuery = '';
				$state.go('auth');
			}
		}
	});

	$rootScope.$watch(function () {return $rootScope.activeVideo}, function (newValue, oldValue) {
		$rootScope.checkTransition();
	});

	$rootScope.checkTransition = function () {
		if ($rootScope.activeVideo) {
			//if the value of active video is adjusted, and is pointing to a valid video, make sure the url matches and start the player
			$state.transitionTo('cbvid.list', {filename: $rootScope.activeVideo.filename}, {notify: false}).then(function() {
				$state.go('cbvid.list.player');
			});
		} else { //if there is no active video, revert back to the home screen
			$state.go('cbvid.home');
		}
	};

	$rootScope.$watch(function () {return $rootScope.videoList}, function (newValue, oldValue) {
		var found = false;
		//this logic is for when a video is deleted and that's the one you were watching.
		if ($rootScope.activeVideo) {
			for (var i = 0; i < $rootScope.videoList.length; i++) {
				if ($rootScope.videoList[i].filename == $rootScope.activeVideo.filename) {
					found = true;
					break;
				}
			}
		}
		if (!found) {
			if ($rootScope.videoList.length > 0) {
				try {
					if (!$rootScope.params.filename) {
						$rootScope.activeVideo = $rootScope.videoList[0];
					}
				} catch (e) {
					$rootScope.activeVideo = $rootScope.videoList[0];
				}
			} else {
				$rootScope.activeVideo = undefined;
			}
		}
	}, true);

	$rootScope.logout = function () {
		$rootScope.socket.emit('logout', UserObj.getUser({ verification: EncryptService.encrypt('logout') }));
	};

	$rootScope.socket.on('logout', function(msg) {
		if ($rootScope.$storage.username == msg.username && $rootScope.$storage.sessionNumber == msg.session) {
			VideoList.reset();
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$localStorage.$reset();
			EncryptService.reset();
			$state.go('auth');
		}
	});

	$rootScope.socket.on('list', function (videoList) {
		$rootScope.$apply(function() {
			VideoList.load(videoList);
		});
	});

	$rootScope.socket.on('listtorrent', function (torrentList) {
		$rootScope.$apply(function() {
			$rootScope.torrentList = torrentList;
		});
	});

	$rootScope.$on('$stateChangeStart', function(event, toState, toParams, fromState, fromParams) {
		//console.log(fromState.name + " to " + toState.name);
		if (toState.name == 'embed' && !$rootScope.canEmbed) {
			event.preventDefault();
		}
		if (toState.name !== 'auth') {
			if (!$rootScope.$storage.authed) {
				$rootScope.pendingState = String(toState.name);
				$rootScope.pendingParameters = JSON.parse(angular.toJson(toParams));
				event.preventDefault();
				$state.go('auth');
				return;
			}
			if ($rootScope.pendingState) {
				event.preventDefault();
				var newDest = String($rootScope.pendingState);
				var newParams = JSON.parse(angular.toJson($rootScope.pendingParameters));
				$rootScope.pendingState = undefined;
				$rootScope.pendingParameters = undefined;
				$state.go(newDest, newParams);
			}
		}
	});
})

.controller('authController', function($scope, $rootScope, $document, $state, EncryptService) {
	$rootScope.setTitle("Login");
	$scope.loading = false;
	$scope.confirmPassword = false;
	$rootScope.srpClient;

	$rootScope.uploading = {};
	$rootScope.processing = {};
	$rootScope.procuring = {};

	$rootScope.credentials = {
		password: "",
		passwordConfirm: ""
	};

	$scope.srpObj;

	if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
		$rootScope.verify();
	}

	$('#username').focus();
	if ($rootScope.$storage.username) {
		$('#password').focus();
	}

	$scope.login = function () {
		if ($rootScope.$storage.username && $rootScope.credentials.password) {
			$rootScope.$storage.authed = false;
			$scope.loading = true;
			delete $rootScope.$storage.sessionNumber;
			if (!$scope.confirmPassword) {
				/*global jsrp*/
				$rootScope.srpClient = new jsrp.client();
				$rootScope.srpClient.init({ username: $rootScope.$storage.username, password: CryptoJS.MD5($rootScope.credentials.password).toString() }, function () {
					$scope.srpObj = {};
					$scope.srpObj.username = $rootScope.$storage.username;
					$scope.srpObj.publicKey = $rootScope.srpClient.getPublicKey();
					$rootScope.socket.emit('login', $scope.srpObj);
				});
			} else {
				if ($rootScope.credentials.passwordConfirm == $rootScope.credentials.password) {
					if ($rootScope.$storage.username.indexOf('@') < 1) {
						alert("Please use a valid e-mail address.");
						$scope.loading = false;
					} else {
						$rootScope.srpClient.createVerifier(function (err, result) {
							if (!err) {
								$scope.srpObj.salt = result.salt;
								$scope.srpObj.verifier = result.verifier;
								$rootScope.socket.emit('new', $scope.srpObj);
							} else {
								console.log("Error creating verifier.");
							}
					    });
					}
				} else {
					alert("Your passwords do not match.  Please try again.");
					$rootScope.credentials.passwordConfirm = "";
					$rootScope.credentials.password = "";
					$("#password").focus();
				}
			}
		}
	};

	$rootScope.socket.on('new', function () {
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.confirmPassword = true;
		});
		$('#confirm').focus();
	});

	$rootScope.socket.on('login', function (srpResponse) {
		$scope.$apply(function () {
			$rootScope.srpClient.setSalt(srpResponse.salt);
			$rootScope.srpClient.setServerPublicKey(srpResponse.publicKey);
			$rootScope.$storage.secret = $rootScope.srpClient.getSharedKey();
			try {
				$rootScope.$storage.sessionNumber = CryptoJS.AES.decrypt(srpResponse.encryptedPhrase, $rootScope.$storage.secret).toString(CryptoJS.enc.Utf8);
			} catch (e) { }
			var successBool = (!isNaN($rootScope.$storage.sessionNumber) && $rootScope.$storage.sessionNumber > 0);
			$scope.loading = false;
			if (!successBool) {
				$scope.error = true;
				$rootScope.credentials.password = "";
			} else {
				$scope.error = false;
			}
		});
	});

	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$rootScope.credentials.passwordConfirm = "";
		$rootScope.$storage.username = $rootScope.$storage.username.replace(/[^\w\.@-]/g, '');
		$rootScope.$storage.username = $rootScope.$storage.username.toLowerCase();
	};
})

.controller('containerController', function($scope, $rootScope, $modal, $state, $timeout, EncryptService, UserObj) {
	$rootScope.viewers = [];
	$rootScope.activeVideo;
	var timer;

	$scope.searchtor = function() {
		$timeout.cancel(timer);
		if ($rootScope.staleQuery !== $rootScope.search.text) {
			$rootScope.torrentList = [];
		}
		timer = $timeout(function() {
			if (!$rootScope.staleQuery || $rootScope.staleQuery !== $rootScope.search.text) {
				$rootScope.socket.emit('listtorrent', UserObj.getUser({ query: $rootScope.search.text, encryptedPhrase: EncryptService.encrypt('listtorrent') }));
				$rootScope.staleQuery = $rootScope.search.text;
			}
		}, 2000);
	};

	$scope.sendTorrent = function(torrentLink) {
		$rootScope.socket.emit('torrent', UserObj.getUser({ torrentLink: EncryptService.encrypt(torrentLink), viewers: [] }));
		$scope.showProgressDialog();
	};

	$scope.showUploadDialog = function () {
		$scope.uploadModal = $modal.open({
			animation: true,
			templateUrl: 'uploadForm.html',
			controller: 'UploadForm',
			size: 'md',
			scope: $scope
		});

		$scope.uploadModal.result.then(function (shouldShowProgress) {
			if (shouldShowProgress) {
				$scope.showProgressDialog();
			}
		});
	};

	$scope.showProgressDialog = function () {
		$scope.progressModal = $modal.open({
			animation: true,
			templateUrl: 'progressForm.html',
			controller: 'ProgressForm',
			size: 'md',
			scope: $scope
		});
	};

	$scope.uploadFile = function () {
		if (document.getElementById("file").files.length > 0) {
			var oData = new FormData();
			oData.append("username", $rootScope.$storage.username);
			oData.append("session", $rootScope.$storage.sessionNumber);
			oData.append("date", EncryptService.encrypt(Date.now().toString()));
			oData.append("viewers", angular.toJson($rootScope.viewers));
			$rootScope.viewers = [];
			oData.append("file", document.getElementById("file").files[0]);
			var filename = document.getElementById("file").files[0].name;
			$rootScope.uploading[filename] = {};
			$rootScope.uploading[filename].percent = 0;
			var oReq = new XMLHttpRequest();
			oReq.upload.addEventListener('progress', function (e) {
				$scope.$apply(function () {
					$rootScope.uploading[filename].percent = Math.floor(e.loaded / e.total * 100).toFixed(0);
				});
			}, false);
			oReq.open("post", "upload", true);
			oReq.responseType = "text";
			oReq.onreadystatechange = function () {
				if (oReq.readyState == 4 && oReq.status == 200) {
					var md5 = oReq.response;
					$scope.$apply(function () {
						delete $rootScope.uploading[filename];
						$rootScope.processing[md5] = {};
						$rootScope.processing[md5].percent = 0;
						$rootScope.sendSubscriptions();
					});
				} else if (oReq.readyState == 4 && oReq.status !== 200) {
					alert("There was an error uploading your file");
				}
			};
			$("#file").replaceWith($("#file").clone());
			oReq.send(oData);
			return true;
		} else {
			return false;
		}
	};

	$rootScope.socket.on('procuring', function(obj) {
		$scope.$apply(function () {
			$rootScope.procuring[obj.md5] = {};
			$rootScope.procuring[obj.md5].percent = 0;
			$rootScope.procuring[obj.md5].name = obj.name;
			$rootScope.sendSubscriptions();
		});
	});

	$rootScope.socket.on('processing', function (obj) {
		$scope.$apply(function () {
			$rootScope.processing[obj.md5] = {};
			$rootScope.processing[obj.md5].percent = 0;
			$rootScope.processing[obj.md5].name = obj.name;
			$rootScope.sendSubscriptions();
		});
	});

	$rootScope.socket.on('progress', function (msg){
		$scope.$apply(function () {
			var relevantArr;
			if (msg.type == 'processing') {
				relevantArr = $rootScope.processing;
			} else {
				relevantArr = $rootScope.procuring;
			}
			var percent;
			if (relevantArr[msg.md5]) {
				if (msg.percent) {
					percent = Math.floor(msg.percent).toFixed(0);
					relevantArr[msg.md5].percent = percent;
				} else {
					delete relevantArr[msg.md5].percent;
				}
				if (msg.timestamp) {
					relevantArr[msg.md5].timestamp = msg.timestamp;
				}
				if (!relevantArr[msg.md5].name && msg.name) {
					relevantArr[msg.md5].name = msg.name;
				}
			}
			if (percent >= 100) {
				try {
					delete relevantArr[msg.md5];
					$rootScope.socket.emit('unsubscribe', msg.md5);
					if (msg.type == "processing" && Object.keys($rootScope.processing).length == 0 && Object.keys($rootScope.procuring).length == 0 && Object.keys($rootScope.uploading).length == 0) {
						$scope.progressModal.close();
					}
				} catch (e) {}
			}
		});
	});
})

.controller('homeController', function ($scope, $rootScope, $state) {
	$rootScope.setTitle("Home");
	$rootScope.checkTransition();
})

.controller('playerController', function($scope, $rootScope, $state, $sce, $modal, EncryptService) {
	$rootScope.setTitle($rootScope.activeVideo.details.original);
	$scope.videoFile;
	
	/*global MP4Box*/
	$scope.mp4box = new MP4Box();

	/*global Downloader*/
	$scope.downloader = new Downloader();
	
	$scope.video;
	
	$rootScope.canEmbed = false;

	$scope.videoString = function (videoFile) {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			$scope.videoFile = videoFile;
			/*global btoa*/
			return $sce.trustAsResourceUrl("./download.mp4?" + "username=" + $rootScope.$storage.username + "&session=" + $rootScope.$storage.sessionNumber + "&file=" + btoa(EncryptService.encrypt($scope.videoFile)));
		}
	};

	$scope.showUpdateDialog = function () {
		$scope.progressModal = $modal.open({
			animation: true,
			templateUrl: 'updateForm.html',
			controller: 'UpdateForm',
			size: 'md',
			scope: $scope
		});
	};

	$scope.setVideo = function () {
		$('video').each(function() {
			$($(this)[0]).attr('src', '');
			$(this)[0].pause();
			$(this)[0].load();
		});
		$("#flow").remove();
		if ($rootScope.activeVideo.filename) {
			delete $rootScope.params.filename;
			
			$('<div/>', { id: 'flow' }).appendTo('.player');
			$("#flow").flowplayer({
				fullscreen: true,
				native_fullscreen: true,
			    clip: {
			    	sources: [
			              {
			              	type: "video/mp4",
			                src:  $scope.videoString($rootScope.activeVideo.filename)
			              }
			        ]
			    }
			});
			
			$scope.video = $('.fp-engine')[0];
			$scope.downloader.reset();
			
			$scope.video.addEventListener("seeking", function(e) {
				var i, start, end;
				var seek_info;
				if ($scope.video.lastSeekTime !== $scope.video.currentTime) {
					for (i = 0; i < $scope.video.buffered.length; i++) {
						start = $scope.video.buffered.start(i);
						end = $scope.video.buffered.end(i);
						if ($scope.video.currentTime >= start && $scope.video.currentTime <= end) {
							return;
						}
					}
					$scope.downloader.stop();
					seek_info = $scope.mp4box.seek($scope.video.currentTime, true);
					$scope.downloader.setChunkStart(seek_info.offset);
					$scope.downloader.resume();
					$scope.video.lastSeekTime = $scope.video.currentTime;
				}
			});
		    $scope.video.playing = false;
		    $scope.video.addEventListener("playing", function(e) { 
		    	$scope.video.playing = true;
		    });
			
			$scope.resetMediaSource();
		
			if ($rootScope.embed) {
				$('#flow').css('max-width', '100%');
			}
			$('.fp-engine').attr('preload', 'auto');
			$('.fp-embed').remove();
			$('.fp-brand').remove();
			$('a[href*="flowplayer"]').remove();
			$('.fp-context-menu').addClass('hidden');
			$('.fp-volume').css('right', '40px');
		}
	};
	
	$scope.resetMediaSource = function() {
		/*global MediaSource*/
		var mediaSource = new MediaSource();
		mediaSource.video = $scope.video;
		$scope.video.ms = mediaSource;
		mediaSource.addEventListener("sourceopen", function(e) {
			if ($scope.video.ms.readyState !== "open") {
				return;
			}
			
			$scope.mp4box.onReady = function (info) {
				$scope.video.ms.duration = info.duration/info.timescale;
				if (!$scope.downloader.isStopped()) {
					$scope.downloader.stop();
				}
				for (var i = 0; i < info.tracks.length; i++) {
					var track = info.tracks[i];
					var ms = $scope.video.ms;
					var track_id = track.id;
					var codec = track.codec;
					var mime = 'video/mp4; codecs=\"'+codec+'\"';
					if (MediaSource.isTypeSupported(mime)) {
						try {
							var sourceBuffer = ms.addSourceBuffer(mime);
							sourceBuffer.ms = ms;
							sourceBuffer.id = track_id;
							$scope.mp4box.setSegmentOptions(track_id, sourceBuffer, { nbSamples: 1000 } );
							sourceBuffer.pendingAppends = [];
						} catch (e) { }
					}
				}
				var initSegs = $scope.mp4box.initializeSegmentation();
				for (var i = 0; i < initSegs.length; i++) {
					var sb = initSegs[i].user;
					if (i === 0) {
						sb.ms.pendingInits = 0;
					}
					sb.addEventListener("updateend", $scope.onInitAppended);
					sb.appendBuffer(initSegs[i].buffer);
					sb.segmentIndex = 0;
					sb.ms.pendingInits++;
				}
			};
			
			$scope.mp4box.onSegment = function (id, user, buffer, sampleNum) {	
				var sb = user;
				sb.segmentIndex++;
				sb.pendingAppends.push({ id: id, buffer: buffer, sampleNum: sampleNum });
				$scope.onUpdateEnd.call(sb, true, false);
			};
			
			$scope.downloader.setInterval(500);
			$scope.downloader.setChunkSize(1000000);
			$scope.downloader.setUrl($scope.videoString($rootScope.activeVideo.filename));
			$scope.downloader.setCallback(
				function (response, end, error) { 
					var nextStart = 0;
					if (response) {
						nextStart = $scope.mp4box.appendBuffer(response);
					}
					if (end) {
						$scope.mp4box.flush();
					} else {
						$scope.downloader.setChunkStart(nextStart); 			
					}
				}
			);
			$scope.downloader.start();
		});
		
		$scope.video.src = window.URL.createObjectURL(mediaSource);
	};
	
	$scope.onInitAppended = function(e) {
		var sb = e.target;
		if (sb.ms.readyState === "open") {
			sb.sampleNum = 0;
			sb.removeEventListener('updateend', $scope.onInitAppended);
			sb.addEventListener('updateend', $scope.onUpdateEnd.bind(sb, true, true));
			$scope.onUpdateEnd.call(sb, false, true);
			sb.ms.pendingInits--;
			if (sb.ms.pendingInits === 0) {
				$scope.downloader.setChunkStart($scope.mp4box.seek(0, true).offset);
				$scope.mp4box.start();
				$scope.downloader.resume();
			}
		}
	};

	$scope.onUpdateEnd = function(isNotInit, isEndOfAppend) {
		if (isEndOfAppend === true) {
			if (this.sampleNum) {
				$scope.mp4box.releaseUsedSamples(this.id, this.sampleNum);
				delete this.sampleNum;
			}
		}
		if (this.ms.readyState === "open" && this.updating === false && this.pendingAppends.length > 0) {
			var obj = this.pendingAppends.shift();
			this.sampleNum = obj.sampleNum;
			this.appendBuffer(obj.buffer);
		}
	};

	$scope.setVideo();
})

.controller('listController', function ($scope, $rootScope, $state, $timeout, $document, EncryptService, UserObj) {

	$scope.deleteVideo = function (filename, callback) {
		if (confirm("Do you really want to delete this video?")) {
			$rootScope.socket.emit('delete', UserObj.getUser({ file: EncryptService.encrypt(filename) }));
			if (callback) {
				callback();
			}
		}
	};

	$scope.removeMe = function (filename) {
		if (confirm("Do you really want to remove your access to this video?")) {
			$rootScope.socket.emit('remove', UserObj.getUser({ file: EncryptService.encrypt(filename) }));
		}
	};

	$scope.syncURL = function() {
		var found = false;
		//if the url doesn't match the intended video, attempt to find that in the list of videos
		for (var i = 0; i < $rootScope.videoList.length; i++) {
			if ($rootScope.videoList[i].filename == $rootScope.params.filename) {
				$rootScope.activeVideo = $rootScope.videoList[i];
				found = true;
				break;
			}
		}
		if (!found) {
			if ($rootScope.videoList.length > 0) {
				//if there is at least one video the user has access to, default to that in lieu of the intended video
				if ($rootScope.activeVideo && $rootScope.activeVideo.filename !== $rootScope.videoList[0].filename) {
					$rootScope.activeVideo = $rootScope.videoList[0];
				} else {
					$rootScope.checkTransition();
				}
			} else {
				if ($rootScope.activeVideo) {
					$rootScope.activeVideo = undefined;
				} else {
					$rootScope.checkTransition();
				}
			}
		}
	};

	if ((!$rootScope.activeVideo && $rootScope.params.filename) || ($rootScope.activeVideo && $rootScope.params.filename && ($rootScope.activeVideo.filename !== $rootScope.params.filename))) {
		//there is no active video, but there is a url -OR-
		//there is an active video, but it doesn't match the given url
		$scope.syncURL();
	}
})

.controller('UploadForm', function ($scope, $modalInstance, $rootScope, EncryptService, UserObj) {

	$scope.type = "file";
	$scope.custom = {
		magnet: "",
		ingest: "",
		keep: false
	};

	$scope.ok = function () {
		$modalInstance.close(false);
	};
	/*
	$scope.$on('modal.closing', function(event, reason, closed) {
		event.preventDefault();
	});
	*/

	$scope.bootstrap = function() {
		$('input[type=file]').bootstrapFileInput();
	};

	$scope.fileChanged = function() {
		var input = $("#file");
		input.parents('.input-group').find(':text').val(input.val().replace(/\\/g, '/').replace(/.*\//, ''));
	};

	$scope.sendTorrent = function() {
		if ($scope.custom.magnet) {
			$rootScope.socket.emit('torrent', UserObj.getUser({ torrentLink: EncryptService.encrypt($scope.custom.magnet), viewers: angular.toJson($rootScope.viewers), keep: $scope.custom.keep }));
			$rootScope.viewers = [];
			$scope.custom.magnet = "";
			$scope.custom.keep = "";
			$modalInstance.close(true);
		}
	};

	$scope.sendIngest = function() {
		if ($scope.custom.ingest) {
			$rootScope.socket.emit('ingest', UserObj.getUser({ ingestLink: EncryptService.encrypt($scope.custom.ingest), viewers: angular.toJson($rootScope.viewers) }));
			$rootScope.viewers = [];
			$scope.custom.ingest = "";
			$modalInstance.close(true);
		}
	};

	$scope.upload = function() {
		if ($scope.uploadFile()) {
			$modalInstance.close(true);
		}
	};
})

.controller('ProgressForm', function ($scope, $modalInstance) {
	$scope.ok = function () {
		$modalInstance.close();
	};
})

.controller('UpdateForm', function ($scope, $rootScope, $modalInstance, UserObj, EncryptService) {
	$scope.updateVideo = JSON.parse(angular.toJson($rootScope.activeVideo));
	delete $scope.updateVideo.edit;
	delete $scope.updateVideo.new;
	for (var i = 0; i < $scope.updateVideo.permissions.length; i++) {
		if ($scope.updateVideo.permissions[i].username == $rootScope.$storage.username) {
			$scope.updateVideo.permissions.splice(i, 1);
			break;
		}
	}
	$scope.close = function() {
		$modalInstance.close();
	};
	$scope.ok = function () {
		var viewersOK = true;
		for (var i = 0; i < $scope.updateVideo.permissions.length; i++) {
			if ($scope.updateVideo.permissions[i].username.indexOf('@') < 1) {
				viewersOK = false;
				break;
			}
		}
		if (!viewersOK) {
			alert("Please use valid e-mail addresses for viewers.");
			$scope.loading = false;
		} else {
			$rootScope.setTitle($scope.updateVideo.details.original);
			$rootScope.socket.emit('update', UserObj.getUser({ updateVideo: EncryptService.encrypt(angular.toJson($scope.updateVideo)) }));
			$modalInstance.close();
		}
	};
})

.directive('viewers', function() {
	return {
		scope: {
            list: '='
        },
		replace: true,
		restrict: 'E',
		template: '' +
			'<div>' +
				'<table ng-if="list.length > 0" class="table table-striped">' +
					'<tr>' +
						'<td>Viewer</td>' +
						'<td align="right" style="padding-right: 25px">Action</td>' +
					'</tr>' +
					'<tr ng-repeat="user in list">' +
						'<td>' +
							'<input ng-model="user.username" ng-change="checkViewers()" ng-trim="false" class="form-control" type="text" placeholder="Username">' +
						'</td>' +
						'<td align="right" style="padding-right: 0px">' +
							'<button class="btn btn-default" ng-click="list.splice($index, 1)">Remove</button>' +
						'</td>' +
					'</tr>' +
				'</table>' +
				'<div style="padding-bottom: 20px; text-align: right">' +
					'<button class="btn btn-primary" ng-click="list.push({username: \'\', isowner: \'false\'})">+Viewer</button>' +
				'</div>' +
			'</div>',
		controller: function($scope) {
			$scope.checkViewers = function () {
				for (var i = 0; i < $scope.list.length; i++) {
					$scope.list[i].username = $scope.list[i].username.replace(/[^\w\.@-]/g, '');
				}
			};
		}
	};
})

.service('VideoList', function($q, $rootScope, $timeout, $state) {
	this.promise;
	this.fetched;
	this.reset = function () {
		this.fetched = false;
		$rootScope.videoList = [];
	};
	this.reset();
	this.getList = function() {
		this.promise = $q.defer();
		if (this.fetched) {
			this.promise.resolve($rootScope.videoList);
		}
		return this.promise.promise;
	};
	this.load = function (videos) {
		if (videos.username == $rootScope.$storage.username) {
			var clearNew = false;
			for (var i = 0; i < $rootScope.videoList.length; i++) {
				$rootScope.videoList[i].remove = true;
			}
			for (var i = 0; i < videos.edit.length; i++) {
				videos.edit[i].edit = true;
				for (var j = 0; j < $rootScope.videoList.length; j++) {
					if (videos.edit[i].filename == $rootScope.videoList[j].filename) {
						delete $rootScope.videoList[j].permissions;
						delete $rootScope.videoList[j].remove;
						$.extend(true, $rootScope.videoList[j], videos.edit[i]);
						videos.edit[i].used = true;
						break;
					}
				}
				if (!videos.edit[i].used) {
					videos.edit[i].new = true;
					clearNew = true;
					$rootScope.videoList.push(videos.edit[i]);
				}
			}
			for (var i = 0; i < videos.view.length; i++) {
				videos.view[i].edit = false;
				for (var j = 0; j < $rootScope.videoList.length; j++) {
					if (videos.view[i].filename == $rootScope.videoList[j].filename) {
						delete $rootScope.videoList[j].permissions;
						delete $rootScope.videoList[j].remove;
						$.extend(true, $rootScope.videoList[j], videos.view[i]);
						videos.view[i].used = true;
						break;
					}
				}
				if (!videos.view[i].used) {
					videos.view[i].new = true;
					clearNew = true;
					$rootScope.videoList.push(videos.view[i]);
				}
			}
			for (var i = 0; i < $rootScope.videoList.length; i++) {
				if ($rootScope.videoList[i].remove) {
					$rootScope.videoList[i] = undefined;
					$rootScope.videoList.splice(i, 1);
					i--;
				}
			}
			if (clearNew) {
				$timeout(function() {
					for (var i = 0; i < $rootScope.videoList.length; i++) {
						delete $rootScope.videoList[i].new;
					}
				}, 2000);
			}
			//$rootScope.videoList = [].concat($rootScope.videoList.edit).concat($rootScope.videoList.view);
			if (!this.fetched) {
				this.promise.resolve($rootScope.videoList);
			}
			this.fetched = true;
		}
	};
})

.service('EncryptService', function ($rootScope) {
    this.encryptedPhrases;
    this.reset = function() {
    	this.encryptedPhrases = {};
    };
    this.reset();
	this.encrypt = function (text) {
		if (!this.encryptedPhrases[text]) {
		    /*global CryptoJS*/
			this.encryptedPhrases[text] = CryptoJS.AES.encrypt(text, $rootScope.$storage.secret).toString();
		}
		return this.encryptedPhrases[text];
	};
})

.service('UserObj', function ($rootScope) {
	this.getUser = function (extraProps) {
		var loginObj = {};
		loginObj.username = $rootScope.$storage.username;
		loginObj.session = $rootScope.$storage.sessionNumber;
		$.extend(loginObj, extraProps);
		return loginObj;
	};
})

.filter('isEmpty', function () {
	return function (obj) {
		for (var bar in obj) {
			if (obj.hasOwnProperty(bar)) {
				return false;
			}
		}
		return true;
	};
});