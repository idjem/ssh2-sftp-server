"use strict";

const path = require('path');
const fs   = require('fs');

const {Server}  = require('ssh2');
const debug     = require('debug');

const SftpServer = require('../index.js');

const logger =  {
  info  : debug('sftp:example:info'),
  debug : debug('sftp:example:debug'),
  error : debug('sftp:example:error'),
};

class Test {

  constructor() {
    this.hostKey = fs.readFileSync(path.resolve(__dirname, 'server.rsa'));
    this.port    = 2222;
  }

  run() {
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

  _clientSFTP(accept/*, reject*/) {
    var sftpStream = accept();
    new SftpServer(sftpStream);
  }

}

module.exports = Test;

