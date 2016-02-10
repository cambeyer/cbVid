#!/bin/bash
#update the sources
sudo apt-get update
#upgrade any packages that are out of date, keeping existing files and accepting all defaults
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" dist-upgrade
#add dependencies for nvm and install git
sudo apt-get install build-essential libssl-dev git
#add nvm package to install node/npm
#change the version number according to https://github.com/creationix/nvm/releases
sudo curl https://raw.githubusercontent.com/creationix/nvm/v0.30.2/install.sh | bash
#add nvm to the PATH
source ~/.profile
#install the latest stable node
sudo nvm install stable
#clone the repo
git clone https://github.com/cambeyer/cbVid.git
#change directories into the newly-cloned repo
cd ~/cbVid
#run npm to install all project dependencies
sudo npm install
#add the repository for ffmpeg
#sudo add-apt-repository ppa:kirillshkrogalev/ffmpeg-next -y
sudo add-apt-repository ppa:mc3man/trusty-media -y
#update the sources
sudo apt-get update
#install ffmpeg without prompting
sudo apt-get install -y ffmpeg
#add the latest fluent-ffmpeg module from github
sudo rm -rf ./node_modules/fluent-ffmpeg/
git submodule add -f git://github.com/schaermu/node-fluent-ffmpeg.git node_modules/fluent-ffmpeg
git pull && git submodule init && git submodule update && git submodule status
cd node_modules/fluent-ffmpeg/
sudo npm install
#add the cloud9 key for authorized login
sudo echo "KEY HERE" >> ~/.ssh/authorized_keys
#run the cloud9 installer for hooking in from the interface
#curl -sL https://raw.githubusercontent.com/c9/install/master/install.sh | sudo bash
#install libcap2-bin to allow port 80 binding
sudo apt-get install libcap2-bin
#allow nodejs to bind to port 80
sudo setcap cap_net_bind_service=+ep /usr/bin/nodejs