"use strict";
const debug     = require('debug');

const {Server, Client, utils}  = require('ssh2');
const pty       = require('node-pty');

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
        session.once('pty', this._clientPty.bind(this, session));
        session.on('exec', this._clientExec.bind(this, session));
        session.on('sftp', this._clientSFTP.bind(this));
      });
    });

    client.on('end', function() {
      logger.info(`Client is gone`);
    });
  }


  async _clientExec(session, accept, reject, info) {
    logger.info(`Client wants to execute`, info.command);
    var stream = accept();
    let child = exec(info.command);
    child.stderr.pipe(stream.stderr);
    child.stdout.pipe(stream.stdout);
    child.on('exit', (code) => {
      stream.exit(code);
      stream.end();
    });
  }


  _clientSFTP(accept, reject) {
    var sftpStream = accept();
    new sftp(sftpStream);
  }



  _clientPty(session, accept, reject, info) {
    logger.debug(`client asked for pty`);
    accept();
    let {rows, cols} = info;

    session.once('shell', function(accept) {
      logger.info(`client asked for a shell`);
      let stream = accept();
      let child = pty.spawn('cmd.exe', [], {name : 'xterm-color', cols, rows});
      child.on('error', logger.error.bind(logger));
      child.pipe(stream);
      stream.pipe(child);

      session.once('close', child.kill.bind(child));
      session.on('window-change', (accept, reject, info) => {
        logger.info(`Resize`, info);
        child.resize(info.rows, info.cols);
      });
    });
  }

}

module.exports = SFTPServer;

