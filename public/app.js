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
			url: '/videos/',
			templateUrl: 'list.html'
		});

    $urlRouterProvider.otherwise('/auth');
})

.run(function($rootScope, $localStorage, $state, $sce, EncryptService, UserObj) {
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
	
	$rootScope.activeVideo;
	$rootScope.playingVideo;

	$rootScope.torrentList = [];
	$rootScope.staleQuery = "";
	
	/*global flowplayer*/
	flowplayer(function (api, root) {
		api.on("ready", function () {
			api.seek(0, function() {});
		});
		api.on("beforeseek", function(a, b, c) {
			console.log(c);
		});
	});

	$rootScope.setTitle = function(title) {
		$rootScope.title = title + " - cbVid";
	};
	
	$rootScope.pasteTorrent = function() {
		var magnet = prompt("Please paste a torrent or magnet link to stream");
		$rootScope.playTorrent(decodeURIComponent(magnet.split("&dn=")[1].split("&")[0]), magnet);
	};
	
	$rootScope.playTorrent = function(title, magnet) {
		$rootScope.activeVideo = {title: title, magnet: magnet};
		$rootScope.setTitle(title);
		$rootScope.setVideo();
	};
	
	$rootScope.videoString = function (videoFile) {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			$rootScope.playingVideo = videoFile;
			/*global btoa*/
			return $sce.trustAsResourceUrl("./" + $rootScope.$storage.username + "/" + $rootScope.$storage.sessionNumber + "/" + btoa(EncryptService.encrypt($rootScope.playingVideo)) + "/stream.m3u8");
		}
	};

	$rootScope.setVideo = function () {
		$('video').each(function() {
			$($(this)[0]).attr('src', '');
			$(this)[0].pause();
			$(this)[0].load();
		});
		$("#flow").remove();
		if ($rootScope.activeVideo.magnet) {
			$('<div/>', { id: 'flow' }).appendTo('.player');
			var api = $("#flow").flowplayer({
				fullscreen: true,
				native_fullscreen: true,
				autoPlay: true,
			    clip: {
			    	sources: [
			              {
			              	type: "application/x-mpegurl",
			                src:  $rootScope.videoString($rootScope.activeVideo.magnet)
			              }
			        ]
			    }
			});

			$('.fp-engine').attr('preload', 'auto');
			$('.fp-embed').remove();
			$('.fp-brand').remove();
			$('.fp-duration').remove();
			$('.fp-remaining').remove();
			//$('.fp-time').remove();
			$('.fp-timeline').remove();
			$('a[href*="flowplayer"]').remove();
			$('.fp-context-menu').addClass('hidden');
			$('.fp-volume').css('right', '40px');
		}
	};

	$rootScope.socket.on('reconnect', function (num) {
		$rootScope.$apply(function () {
			$rootScope.verify();
		});
	});

	$rootScope.verify = function() {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			console.log("Verifying");
			$rootScope.socket.emit('verify', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('client') }));
		}
	};

	$rootScope.socket.on('verifyok', function(successBool) {
		$rootScope.$storage.authed = successBool !== 'false';
		if (!$rootScope.$storage.authed) {
			$localStorage.$reset({
				username: $rootScope.$storage.username
			});
			EncryptService.reset();
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$state.reload();
		} else {
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
				EncryptService.reset();
				$rootScope.search.text = '';
				$rootScope.staleQuery = '';
				$state.go('auth');
			}
		}
	});

	$rootScope.logout = function () {
		$rootScope.socket.emit('logout', UserObj.getUser({ verification: EncryptService.encrypt('logout') }));
	};

	$rootScope.socket.on('logout', function(msg) {
		if ($rootScope.$storage.username == msg.username && $rootScope.$storage.sessionNumber == msg.session) {
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$localStorage.$reset();
			EncryptService.reset();
			$state.go('auth');
		}
	});

	$rootScope.socket.on('listtorrent', function (torrentList) {
		$rootScope.$apply(function() {
			$rootScope.torrentList = torrentList;
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