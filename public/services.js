/*global angular*/
angular.module('cbVidApp.services', [])
.service('EncryptService', function ($rootScope) {
    this.encryptedPhrases = {};
	this.encrypt = function (text) {
		if (!this.encryptedPhrases[text]) {
		    /*global CryptoJS*/
			this.encryptedPhrases[text] = CryptoJS.AES.encrypt(text, $rootScope.$storage.secret).toString();
		}
		return this.encryptedPhrases[text];
	};
});