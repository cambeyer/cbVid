#!/bin/bash
#update the sources
sudo apt-get update
#upgrade any packages that are out of date, keeping existing files and accepting all defaults
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" dist-upgrade
#add the repository for nodejs
curl -sL https://deb.nodesource.com/setup | sudo bash -
#install node and gcc and git without prompting
sudo apt-get install -y nodejs build-essential git
#clone the repo
git clone https://github.com/cambeyer/cbVid.git
#change directories into the newly-cloned repo
cd ~/cbVid
#run npm to install all project dependencies
sudo npm install
#add the reposotiry for ffmpeg
sudo add-apt-repository ppa:kirillshkrogalev/ffmpeg-next -y
#update the sources
sudo apt-get update
#install ffmpeg without prompting
sudo apt-get install -y ffmpeg
#add the cloud9 key for authorized login
sudo echo "KEY HERE" >> ~/.ssh/authorized_keys
#run the cloud9 installer for hooking in from the interface
curl -sL https://raw.githubusercontent.com/c9/install/master/install.sh | sudo bash
#install libcap2-bin to allow port 80 binding
sudo apt-get install libcap2-bin
#allow nodejs to bind to port 80
sudo setcap cap_net_bind_service=+ep /usr/bin/nodejs