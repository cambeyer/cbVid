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

		.state('cbvid.list', {
			url: '/videos/:filename',
			templateUrl: 'list.html',
			controller: 'listController',
			resolve: {
				videos: function(VideoList, $rootScope, $stateParams, UserObj, EncryptService) {
					$rootScope.params = $stateParams;
					if (!$rootScope.fetched) {
						$rootScope.socket.emit('list', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('list') }));
					}
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

	$rootScope.uploading = {};
	$rootScope.processing = {};
	$rootScope.procuring = {};

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
				$state.go('auth');
			}
		}
	});

	$rootScope.logout = function () {
		$rootScope.socket.emit('logout', UserObj.getUser({ verification: EncryptService.encrypt('logout') }));
	};

	$rootScope.socket.on('logout', function(msg) {
		if ($rootScope.$storage.username == msg.username && $rootScope.$storage.sessionNumber == msg.session) {
			VideoList.reset();
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

	$rootScope.$on('$stateChangeStart', function(event, toState, toParams, fromState, fromParams) {
		//console.log(fromState.name + " to " + toState.name);
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
					$rootScope.srpClient.createVerifier(function (err, result) {
						if (!err) {
							$scope.srpObj.salt = result.salt;
							$scope.srpObj.verifier = result.verifier;
							$rootScope.socket.emit('new', $scope.srpObj);
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
			}
		});
	});

	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$rootScope.credentials.passwordConfirm = "";
		$rootScope.$storage.username = $rootScope.$storage.username.replace(/\W/g, '');
	};
})

.controller('containerController', function($scope, $rootScope, $modal, $state, EncryptService) {
	$rootScope.setTitle("Home");
	$rootScope.viewers = [];
	$rootScope.activeVideo;

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

	$rootScope.socket.on('procuring', function(md5) {
		$scope.$apply(function () {
			$rootScope.procuring[md5] = {};
			$rootScope.procuring[md5].percent = 0;
			$rootScope.sendSubscriptions();
		});
	});

	$rootScope.socket.on('processing', function (md5) {
		$scope.$apply(function () {
			$rootScope.processing[md5] = {};
			$rootScope.processing[md5].percent = 0;
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
					if (msg.type == "processing" && Object.keys($rootScope.processing).length == 0 && Object.keys($rootScope.procuring).length == 0 && Object.keys($rootScope.uploading).length == 0) {
						$scope.progressModal.close();
					}
				} catch (e) {}
			}
		});
	});
})

.controller('playerController', function($scope, $rootScope, $state, $stateParams, $sce, $modal, EncryptService) {
	$rootScope.setTitle($rootScope.activeVideo.details.original);
	$scope.videoFile;

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

	$scope.setVideo();
})

.controller('listController', function ($scope, $rootScope, $state, $stateParams, $timeout, $document, EncryptService, UserObj) {

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

	$rootScope.$watch(function () {return $rootScope.activeVideo}, function (newValue, oldValue) {
		if ($rootScope.activeVideo) {
			//if the value of active video is adjusted, and is pointing to a valid video, make sure the url matches and start the player
			$state.transitionTo('cbvid.list', {filename: $rootScope.activeVideo.filename}, {notify: false}).then(function() {
				$state.go('cbvid.list.player');
			});
		} else if ($state.current.name == 'cbvid.list.player') { //if there is no active video and we were in the player state, revert back to the generic list
			$state.go('cbvid.list');
		}
	});

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
			//the url they are accessing isn't in the list of available videos
			$rootScope.activeVideo = undefined;
		}
	};

	if ((!$rootScope.activeVideo && $rootScope.params.filename) || ($rootScope.activeVideo && $rootScope.params.filename && ($rootScope.activeVideo.filename !== $rootScope.params.filename))) {
		//there is no active video, but there is a url -OR-
		//there is an active video, but it doesn't match the given url
		$scope.syncURL();
	}

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
				//if there is at least one video the user has access to, default to that in lieu of the intended video
				$rootScope.activeVideo = $rootScope.videoList[0];
			} else {
				$rootScope.activeVideo = undefined;
			}
		}
	}, true);
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
			torrentReq['viewers'] = angular.toJson($rootScope.viewers);
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
			ingestReq['viewers'] = angular.toJson($rootScope.viewers);
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
	$scope.ok = function () {
		$rootScope.socket.emit('update', UserObj.getUser({ updateVideo: EncryptService.encrypt(angular.toJson($scope.updateVideo)) }));
		$modalInstance.close();
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
							'<input ng-model="user.username" ng-change="checkViewers()" ng-trim="false" maxlength="20" class="form-control" type="text" placeholder="Username">' +
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
					$scope.list[i].username = $scope.list[i].username.replace(/\W/g, '');
				}
			};
		}
	};
})

.service('VideoList', function($q, $rootScope, $timeout, $state) {
	this.promise;
	this.reset = function () {
		$rootScope.fetched = false;
		$rootScope.videoList = [];
	};
	this.reset();
	this.getList = function() {
		this.promise = $q.defer();
		if ($rootScope.fetched) {
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