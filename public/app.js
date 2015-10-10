/*global angular*/
angular.module('cbVidApp', ['ngAnimate', 'ui.router', 'ngStorage', 'ui.bootstrap'])

.config(function($stateProvider, $urlRouterProvider) {
    $stateProvider
        .state('auth', {
            url: '/auth',
            templateUrl: 'auth.html',
            controller: 'authController'
        })
        
        .state('cbvid', {
            templateUrl: 'cbvid.html',
			controller: 'containerController'
        })
		
		.state('cbvid.video', {
			templateUrl: 'video.html',
			controller: 'videoController'
		})
		
		.state('cbvid.video.player', {
			url: '/video/:filename',
			templateUrl: 'player.html',
			controller: 'playerController',
			resolve: {
				videos: function(VideoList, $rootScope, $stateParams, UserObj, EncryptService) {
					if ($stateParams.filename) {
						$rootScope.pendingVid = $stateParams.filename;
					}
					if (!$rootScope.fetched) {
						$rootScope.socket.emit('list', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('list') }));
					}
					return VideoList.getList();
				}
			}
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
	
	$rootScope.uploading = {};
	$rootScope.processing = {};

	$rootScope.socket.on('reconnect', function (num) {
		$rootScope.$apply(function () {
			$rootScope.verify();
		});
	});
	
	$rootScope.verify = function() {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			$rootScope.socket.emit('verify', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('client') }));
		}
	};
	
	$rootScope.socket.on('verifyok', function(successBool) {
		$rootScope.$storage.authed = successBool !== 'false';
		if (!$rootScope.$storage.authed) {
			alert("Your session has expired.  Please log in again.");
			$localStorage.$reset({
				username: $rootScope.$storage.username
			});
			EncryptService.reset();
			$state.reload();
		} else {
			$state.go('cbvid.video');
		}
	});
	
	$rootScope.logout = function () {
		$rootScope.socket.emit('logout', UserObj.getUser({ verification: EncryptService.encrypt('logout') }));
	};
	
	$rootScope.socket.on('logout', function(msg) {
		if ($rootScope.$storage.username == msg.username && $rootScope.$storage.sessionNumber == msg.session) {
			$localStorage.$reset();
			EncryptService.reset();
			$state.go('auth');
		}
	});
	
	$rootScope.socket.on('list', function (videoList) {
		VideoList.load(videoList);
	});
	
	$rootScope.$on('$stateChangeStart', function(event, toState, toParams, fromState, fromParams) { 
		if (toState.name !== 'auth') {
			if (!$rootScope.$storage.authed) {
				$rootScope.pendingState = String(toState.name);
				$rootScope.pendingParameters = JSON.parse(JSON.stringify(toParams));				
				event.preventDefault();
				$state.go('auth');
				return;
			}
			if ($rootScope.pendingState) {
				event.preventDefault();
				var newDest = String($rootScope.pendingState);
				var newParams = JSON.parse(JSON.stringify($rootScope.pendingParameters));
				$rootScope.pendingState = '';
				$rootScope.pendingParameters = '';
				$state.go(newDest, newParams);
			}
		}
	});	
})

.controller('authController', function($scope, $rootScope, $document, $state, EncryptService) {
	$rootScope.title = "Login";
	$scope.loading = false;
	$scope.confirmPassword = false;
	$rootScope.srpClient;
	$rootScope.credentials = {
		password: "",
		passwordConfirm: ""
	};
	
	if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
		$rootScope.verify();
	}
	
	$document.ready(function (){
		$('#username').focus();
		if ($rootScope.$storage.username) {
			$('#password').focus();
		}
	});

	$scope.login = function () {
		if ($rootScope.$storage.username && $rootScope.credentials.password) {
			$rootScope.$storage.authed = false;
			$scope.loading = true;
			delete $rootScope.$storage.sessionNumber;
			if (!$scope.confirmPassword) {
				/*global jsrp*/
				$rootScope.srpClient = new jsrp.client();
				/*global CryptoJS*/
				$rootScope.srpClient.init({ username: $rootScope.$storage.username, password: CryptoJS.MD5($rootScope.credentials.password).toString() }, function () {
					var srpObj = {};
					srpObj.username = $rootScope.$storage.username;
					srpObj.publicKey = $rootScope.srpClient.getPublicKey();
					$rootScope.socket.emit('login', srpObj);
				});
			} else {
				if ($rootScope.credentials.passwordConfirm == $rootScope.credentials.password) {
					$rootScope.srpClient.createVerifier(function (err, result) {
						if (!err) {
							var srpObj = {};
							srpObj.salt = result.salt;
							srpObj.verifier = result.verifier;
							$rootScope.socket.emit('new', srpObj);
						} else {
							console.log("Error creating verifier.");
						}
				    });
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
				$rootScope.verify();
			}
		});
	});
	
	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$rootScope.credentials.passwordConfirm = "";
		$rootScope.$storage.username = $rootScope.$storage.username.replace(/\W/g, '');
	};
})

.controller('containerController', function($scope, $rootScope, $modal, EncryptService) {
	$rootScope.title = "Home";
	
	$rootScope.viewers = [];
	
	$scope.sendSubscriptions = function() {
		for (var md5 in $rootScope.processing) {
			$rootScope.socket.emit('subscribe', md5);
		}
	};
	
	$scope.sendSubscriptions();
	
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
			oData.append("viewers", JSON.stringify($rootScope.viewers));
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
						$scope.sendSubscriptions();
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
	
	$rootScope.socket.on('processing', function (md5) {
		$scope.$apply(function () {
			$rootScope.processing[md5] = {};
			$rootScope.processing[md5].percent = 0;
			$scope.sendSubscriptions();
		});
	});
	
	$rootScope.socket.on('progress', function (msg){
		$scope.$apply(function () {
			var percent;
			if (msg.percent) {
				percent = Math.floor(msg.percent).toFixed(0);
				$rootScope.processing[msg.md5].percent = percent;
			} else {
				delete $rootScope.processing[msg.md5].percent;
			}
			$rootScope.processing[msg.md5].timestamp = msg.timestamp;
			if (!$rootScope.processing[msg.md5].name && msg.name) {
				$rootScope.processing[msg.md5].name = msg.name;
			}
			if (percent >= 100) {
				try {
					delete $rootScope.processing[msg.md5];
					if (Object.keys($rootScope.processing).length == 0 && Object.keys($rootScope.uploading).length == 0) {
						$scope.progressModal.close();
					}
				} catch (e) {}
			}
		});
	});
})

.controller('playerController', function($scope, $rootScope, $state, $stateParams, $sce, EncryptService) {
	$rootScope.activeVideo;
	$rootScope.pendingVid = "";
	$scope.videoFile;

	$scope.videoString = function (videoFile) {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			$scope.videoFile = videoFile;
			/*global btoa*/
			return $sce.trustAsResourceUrl("./download?" + "username=" + $rootScope.$storage.username + "&session=" + $rootScope.$storage.sessionNumber + "&file=" + btoa(EncryptService.encrypt($scope.videoFile)));
		}
	};
	
	$scope.setVideo = function () {
		$("#flow").remove();
		if ($rootScope.activeVideo.filename) {
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

			$('.fp-engine').attr('preload', 'auto');
			$('.fp-embed').remove();
			$('.fp-brand').remove();
			$('a[href*="flowplayer"]').remove();
			$('.fp-context-menu').addClass('hidden');
			$('.fp-volume').css('right', '40px');
		}
	};
	
	if ($stateParams.filename) {
		var found = false;
		for (var i = 0; i < $rootScope.videoList.length; i++) {
			if ($stateParams.filename == $rootScope.videoList[i].filename) {
				$rootScope.activeVideo = $rootScope.videoList[i];
				$rootScope.title = $rootScope.activeVideo.details.original;
				$scope.setVideo();
				found = true;
				break;
			}
		}
		if (!found) {
			alert("You do not have access to the video or it may have been deleted.");
			$state.go('cbvid.video');
		}
	}
})

.controller('videoController', function ($scope, $rootScope, $state, $stateParams, $timeout, $document, EncryptService, UserObj) {

	$scope.deleteVideo = function (filename) {
		if (confirm("Do you really want to delete this video?")) {
			$rootScope.socket.emit('delete', UserObj.getUser({ file: EncryptService.encrypt(filename) }));
		}
	};

	$scope.removeMe = function (filename) {
		if (confirm("Do you really want to remove your access to this video?")) {
			$rootScope.socket.emit('remove', UserObj.getUser({ file: EncryptService.encrypt(filename) }));
		}
	};
})

.controller('UploadForm', function ($scope, $modalInstance, $rootScope, EncryptService) {

	$scope.type = "file";
	$scope.custom = {
		magnet: "",
		ingest: ""
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

	$scope.checkViewers = function () {
		for (var i = 0; i < $rootScope.viewers.length; i++) {
			$rootScope.viewers[i].username = $rootScope.viewers[i].username.replace(/\W/g, '');
		}
	};

	$scope.fileChanged = function() {
		var input = $("#file");
		input.parents('.input-group').find(':text').val(input.val().replace(/\\/g, '/').replace(/.*\//, ''));
	};

	$scope.sendTorrent = function() {
		if ($scope.custom.magnet) {
			var torrentReq = {};
			torrentReq['username'] = $rootScope.$storage.username;
			torrentReq['session'] = $rootScope.$storage.sessionNumber;
			torrentReq['torrentLink'] = EncryptService.encrypt($scope.custom.magnet);
			torrentReq['viewers'] = JSON.stringify($rootScope.viewers);
			$rootScope.viewers = [];
			$scope.custom.magnet = "";
			$rootScope.socket.emit('torrent', torrentReq);
			$modalInstance.close(true);
		}
	};

	$scope.sendIngest = function() {
		if ($scope.custom.ingest) {
			var ingestReq = {};
			ingestReq['username'] = $rootScope.$storage.username;
			ingestReq['session'] = $rootScope.$storage.sessionNumber;
			ingestReq['ingestLink'] = EncryptService.encrypt($scope.custom.ingest);
			ingestReq['viewers'] = JSON.stringify($rootScope.viewers);
			$rootScope.viewers = [];
			$scope.custom.ingest = "";
			$rootScope.socket.emit('ingest', ingestReq);
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

.service('VideoList', function($q, $rootScope, $timeout, $state) {
	this.promise;
	$rootScope.fetched = false;
	$rootScope.videoList = [];
	this.getList = function() {
		this.promise = $q.defer();
		if ($rootScope.fetched) {
			this.promise.resolve($rootScope.videoList);
		}
		return this.promise.promise;
	};
	this.load = function (videos) {
		alert('load');
		if (videos.username == $rootScope.$storage.username) {
			var clearNew = false;
			for (var i = 0; i < $rootScope.videoList.length; i++) {
				$rootScope.videoList[i].remove = true;
			}
			for (var i = 0; i < videos.edit.length; i++) {
				videos.edit[i].edit = true;
				for (var j = 0; j < $rootScope.videoList.length; j++) {
					if (videos.edit[i].filename == $rootScope.videoList[j].filename) {
						$rootScope.videoList[j] = videos.edit[i];
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
						$rootScope.videoList[j] = videos.view[i];
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
			if (!$rootScope.fetched) {
				this.promise.resolve($rootScope.videoList);
			}
			$rootScope.fetched = true;
			var found = false;
			if ($rootScope.activeVideo) {
				for (var i = 0; i < $rootScope.videoList.length; i++) {
					if ($rootScope.activeVideo.filename == $rootScope.videoList[i].filename) {
						found = true;
						break;
					}
				}
			}
			if (!found && !$rootScope.pendingVid) {
				if ($rootScope.videoList.length > 0) {
					$rootScope.activeVideo = $rootScope.videoList[0];
					$state.go('cbvid.video.player', { filename: $rootScope.activeVideo.filename } );
				} else {
					$rootScope.activeVideo = "";
					$state.go('cbvid.video.player');
				}
			}
		}
	};
})

.service('EncryptService', function ($rootScope) {
    this.encryptedPhrases = {};
    this.reset = function() {
    	this.encryptedPhrases = {};
    };
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