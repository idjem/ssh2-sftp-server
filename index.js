'use strict';

const path    = require('path');
const fs      = require('fs');

const debug = require('debug');

const strftime  = require('mout/date/strftime');
const pick      = require('mout/object/pick');

const {getLogicalDisks, wslpath, winpath} = require('./utils/');

//from stream scope
var SFTP_OPEN_MODE, SFTP_STATUS_CODE;
var flagsToString;

function pathRemoteToLocal(remotepath) {
  return winpath(remotepath);
}

function pathLocalToRemote(localpath) {
  return wslpath(localpath);
}


const logger = {
  debug : debug('sftp:debug'),
  info  : debug('sftp:info'),
  error : debug('sftp:error')
};


const errorCode = (code) => {
  if(['ENOTEMPTY', 'ENOTDIR', 'ENOENT'].includes(code))
    return SFTP_STATUS_CODE.NO_SUCH_FILE;
  if(['EACCES', 'EEXIST', 'EISDIR'].includes(code))
    return SFTP_STATUS_CODE.PERMISSION_DENIED;
  return SFTP_STATUS_CODE.FAILURE;
};


const modeLinux = (filename, filepath) => {

  const Correspondances = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

  if(filename == "" && filepath != "/") { //this is root
    filename = filepath.toLowerCase().replace(':', '');
  }

  let user = 'user', group = 'user', uid = 1000;

  try {
    const stats = fs.statSync(filepath);
    const unixFilePermissions = (stats.mode & parseInt('777', 8)).toString(8);

    var type = stats.isDirectory() ? 'd' : '-';
    let mode = '';
    for(let i = 0; i < unixFilePermissions.length; i++)
      mode = mode + Correspondances[unixFilePermissions.charAt(i)];
    var date = strftime(new Date(stats.mtime), "%b %d %H:%M");//Jun 16 14:41
    let longname = [type + mode, stats.nlink, user, group, stats.size, date, filename].join(' ');
    let attrs = pick(stats, ['mode', 'uid', 'gid', 'size', 'atime', 'mtime']);
    attrs.uid = attrs.gid = uid;

    return {filename, longname, attrs};
  } catch(err) {
    logger.error(err.message);
    return {
      filename,
      longname :  `?????????? ? ? ? ? ? ? ? ${filename}`
    };
  }
};

class SFTP {

  constructor(sftpStream) {

    ({flagsToString} = sftpStream.constructor);
    ({OPEN_MODE : SFTP_OPEN_MODE, STATUS_CODE : SFTP_STATUS_CODE} = sftpStream.constructor);

    this.openFiles = {};
    this._handleCount = 0;
    this.sftpStream = sftpStream;

    sftpStream.on('OPEN', this._open.bind(this));
    sftpStream.on('CLOSE', this._close.bind(this));
    sftpStream.on('REALPATH', this._realpath.bind(this));
    sftpStream.on('STAT', this._onSTAT.bind(this, 'statSync'));
    sftpStream.on('OPENDIR', this._opendir.bind(this));
    sftpStream.on('READ', this._read.bind(this));
    sftpStream.on('REMOVE', this._remove.bind(this));
    sftpStream.on('RMDIR', this._rmdir.bind(this));
    sftpStream.on('MKDIR', this._mkdir.bind(this));
    sftpStream.on('RENAME', this._rename.bind(this));
    sftpStream.on('READDIR', this._readdir.bind(this));
    sftpStream.on('WRITE', this._write.bind(this));
    sftpStream.on('LSTAT', this._onSTAT.bind(this, 'lstatSync'));
    sftpStream.on('FSTAT', (reqID, handle) => {
      this._onSTAT('fstatSync', reqID, this.openFiles[handle].filepath, handle);
    });
  }

  _write(reqid, handle, offset, data) {
    //var state = this.openFiles[handle];
    fs.writeSync(handle[0], data, 0, data.length, offset);
    logger.debug('write to file at offset %d, length %d', offset, data.length);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _close(reqid, fd) {
    fs.closeSync(fd[0]);
    logger.info('CLOSE', {reqid, fd});
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _realpath(reqid, filename) {
    logger.info('realpath ', filename, pathRemoteToLocal(filename));

    //filename = path.posix.normalize(filename);
    filename = pathLocalToRemote(pathRemoteToLocal(filename));
    logger.info('REALPATH normalize ', filename);
    this.sftpStream.name(reqid, [{filename}]);
  }

  _onSTAT(statType, reqid, remotepath, handle) {
    let filepath = pathRemoteToLocal(remotepath);
    logger.info('STAT', {filepath, remotepath, statType, handle});
    try {
      var fstats = fs[statType](filepath);
      let stats = pick(fstats, ['mode', 'uid', 'gid', 'size', 'atime', 'mtime']);

      if(handle && this.openFiles[handle])
        this.openFiles[handle].stats = stats;
      return this.sftpStream.attrs(reqid, stats);
    } catch(err) {
      logger.error(err);
      return this.sftpStream.status(reqid, errorCode(err.code));
    }
  }

  _opendir(reqid, remotepath) {

    let filepath = pathRemoteToLocal(remotepath);
    logger.info('OPENDIR', {reqid, filepath, remotepath});

    try {
      let stat = fs.statSync(filepath);
      if(!stat.isDirectory()) {
        this.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
        return;
      }
    } catch(err) {
      this.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
      return;
    }

    return this._open(reqid, remotepath, SFTP_OPEN_MODE.READ);
  }


  _read(reqid, handle, offset, length) {
    logger.debug('READ', {reqid, offset, length});
    var state = this.openFiles[handle];

    if(offset >= state.stat.size)
      return this.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);

    var size = state.stat.size - state.pos > length ? length : state.stat.size - state.pos;
    var buffer = new Buffer(size);

    fs.readSync(handle[0], buffer, 0, size, offset);
    state.pos += size;

    this.sftpStream.data(reqid, buffer);
  }


  _rename(reqid, remotepath, newremotePath) {
    let filepath = pathRemoteToLocal(remotepath);
    let newfilepath = pathRemoteToLocal(newremotePath);
    logger.info('RENAME', {filepath, remotepath, newfilepath, newremotePath});
    fs.renameSync(filepath, newfilepath);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }


  _remove(reqid, remotepath) {
    let filepath = pathRemoteToLocal(remotepath);
    logger.info('REMOVE', {filepath, remotepath});
    fs.unlinkSync(filepath);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _rmdir(reqid, remotepath) {
    let filepath = pathRemoteToLocal(remotepath);
    logger.info('RMDIR', {filepath, remotepath});
    fs.rmdirSync(filepath);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _mkdir(reqid, remotepath /*, attrs*/) {
    let filepath = pathRemoteToLocal(remotepath);
    fs.mkdirSync(filepath);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }


  async _readdir(reqid, handle) {
    logger.info('READDIR', this.openFiles[handle].filepath);
    if(this.openFiles[handle].closed) {
      this.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
      return;
    }

    var names = [];

    if(this.openFiles[handle].filepath == '/') {
      names = await getLogicalDisks();
      names = names.map((v) => modeLinux("", v));
    } else {
      names = fs.readdirSync(this.openFiles[handle].filepath);
      names.push('.', '..');
      names = names.map((v) => modeLinux(v, path.join(this.openFiles[handle].filepath, v)));
    }
    this.openFiles[handle].closed = true;
    this.sftpStream.name(reqid, names);
  }

  _open(reqid, filepath, flags, attrs) {
    filepath = pathRemoteToLocal(filepath);
    flags  = flagsToString(flags);

    logger.info('OPEN', {reqid, filepath, flags, attrs});
    if(flags != "w" && !fs.existsSync(filepath))
      return this.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);

    var handle = fs.openSync(filepath, flags);
    let stat = fs.statSync(filepath);
    handle = Buffer.from([handle]);
    this.openFiles[handle] = {filepath, flags, stat, pos : 0};
    return this.sftpStream.handle(reqid, handle);
  }
}


module.exports = SFTP;
