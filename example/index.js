"use strict";
const debug     = require('debug');
const fs = require('fs');
const path = require('path');
const {Server, Client, utils}  = require('ssh2');

const sftp = require('../index.js');

const logger =  {
  info  : debug('tunnel:info'),
  debug : debug('tunnel:debug'),
  error : debug('tunnel:error'),
};

class SFTPServer {

  constructor() {

    this.hostKey = fs.readFileSync(path.resolve(__dirname, 'server.rsa'));
    this.port    = 2222;

  }


  async run() {
    logger.info(`ivs-device ready with`, this.device_key);
    const localServer = await this.startLocalSSHServer();

  }


  startLocalSSHServer() {
    let server = new Server({
      hostKeys : [this.hostKey]
    }, this._newClient.bind(this));

    return new Promise((resolve) => {
      server.listen(this.port, function() {
        logger.info(`Listening on port`, this.address().port);
        resolve(this.address().port);
      });
    });
  }
  

  _newClient(client) {
    logger.info(`new client connecting`);

    client.on('error', logger.error.bind(logger));
    client.on('authentication', (ctx) => {
      ctx.accept(); //now ready
    });

    client.on('ready', () => { //after auth
      client.on('session', (accept) => {
        let session = accept();
        session.on('sftp', this._clientSFTP.bind(this));
      });
    });

    client.on('end', function() {
      logger.info(`Client is gone`);
    });
  }



  _clientSFTP(accept, reject) {
    var sftpStream = accept();
    new sftp(sftpStream);
  }



}

module.exports = SFTPServer;

