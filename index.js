'use strict';

const path    = require('path');
const fs      = require('fs');
const debug = require('debug');
const stripStart = require('nyks/string/stripStart');


const logger = {
  info  : debug('sftp:info'),
  error : debug('sftp:error')
};

const {SFTP_OPEN_MODE, SFTP_STATUS_CODE}  = require('ssh2');
const {flagsToString} = require('ssh2-streams/lib/sftp');
const pick      = require('mout/object/pick');
const deleteFolderRecursive = require('nyks/fs/deleteFolderRecursive');

const errorCode = (code) => {
  if(['ENOTEMPTY', 'ENOTDIR', 'ENOENT'].includes(code))
    return SFTP_STATUS_CODE.NO_SUCH_FILE;
  if(['EACCES', 'EEXIST', 'EISDIR'].includes(code))
    return SFTP_STATUS_CODE.PERMISSION_DENIED;
  return SFTP_STATUS_CODE.FAILURE
}


//https://www.martin-brennan.com/nodejs-file-permissions-fstat/
const modeLinux = (file_path) => {
  const Correspondances = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const filename = path.parse(file_path).base || path.parse(file_path).root;

  try {
    const stats = fs.statSync(file_path);
    const unixFilePermissions = (stats.mode & parseInt('777', 8)).toString(8);
    var result = stats.isDirectory() ? 'd' : '-'; 
    for (var i = 0; i < unixFilePermissions.length; i++)
      result = result + Correspondances[unixFilePermissions.charAt(i)];
    var date = Date(stats.atime).split(' ');
    return {
      filename,
      longname :  `${result} 1 ivs ivs ${stats.size} ${date[1]} ${date[2]} ${date[3]} ${filename}`,
      attrs: pick(stats, ['mode', 'uid', 'gid', 'size', 'atime', 'mtime'])
    }
  } catch(err) {
    logger.error(err.message);
    return {
      filename,
      longname :  `?????????? ? ? ? ? ? ? ? ${filename}`
    }
  }
}


const racine = ['D:/', 'C:/'];

class SFTP {

  constructor(sftpStream) {
    this.openFiles = {};
    this._handleCount = 0;
    sftpStream.on('OPEN', this._open.bind(this));
    sftpStream.on('CLOSE', this._close.bind(this));
    sftpStream.on('REALPATH', this._realpath.bind(this));
    sftpStream.on('STAT', this._onSTAT.bind(this, 'STAT'));
    sftpStream.on('LSTAT', this._onSTAT.bind(this, 'LSTAT'));
    sftpStream.on('FSTAT', (reqID, handle) => {
      this._onSTAT('FSTAT', reqID, this.openFiles[handle].path, handle);
    });
    sftpStream.on('OPENDIR', this._opendir.bind(this));
    sftpStream.on('READ', this._read.bind(this));
    sftpStream.on('REMOVE', this._remove.bind(this));
    sftpStream.on('RMDIR', this._rmdir.bind(this));
    sftpStream.on('MKDIR', this._mkdir.bind(this));
    sftpStream.on('RENAME', () => {});
    sftpStream.on('READDIR', this._readdir.bind(this));
    sftpStream.on('WRITE', this._write.bind(this));
    this.sftpStream = sftpStream;
  }

  fetchhandle() {
    var prevhandle;
    prevhandle = this._handleCount;
    this._handleCount++;
    return new Buffer(prevhandle.toString());
  };

  _write(reqid, handle, offset, data) {
    var buffer = new Buffer(data);
    var state = this.openFiles[handle];
    if(state.readed)
      return sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
    else {
      const fd = fs.openSync(state.path, "w");
      fs.writeSync(fd, buffer, 0, buffer.length, offset)
      state.read = true;
      console.log('write to file at offset %d, length %d', offset, buffer.length);
    }
  }

  _close() {
    logger.info('CLOSE')
  }

  _realpath(reqid, filename) {
    //filename = path.normalize(filename);
    logger.info('realpath ', filename)
    /*if(filename == '.')
      filename = 'D:/'*/
    filename = path.posix.normalize(filename);
    logger.info('REALPATH normalize ', filename)
    this.sftpStream.name(reqid, [{filename}]);
  }

  _onSTAT(statType, reqid, path, handle) {
    try {
      logger.info({statType})
      logger.info('STAT', path);
      var stats = pick(fs.statSync(path), ['mode', 'uid', 'gid', 'size', 'atime', 'mtime']);
      if(handle && this.openFiles[handle])
        this.openFiles[handle].stats = stats;
      return this.sftpStream.attrs(reqid, stats);
    } catch(err) {
      logger.error(err);
      return this.sftpStream.status(reqid, errorCode(err.code));
    }
  }

  _opendir(reqid, path) {
    var handle = this.fetchhandle();
    this.openFiles[handle] = { opened : false , path};
    this.sftpStream.handle(reqid, handle);
  }

  _read(reqid, handle, offset, length) {
    logger.info('READ', offset, length);
    var state = this.openFiles[handle];

    if(offset > state.stats.size)
      return this.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);

    const fd = fs.openSync(state.path, "r");
    var d = state.stats.size - state.readed > length ? length : state.stats.size - state.readed;
    var buffer = new Buffer(d);
    fs.readSync(fd, buffer, 0, d, offset);
    state.readed = state.readed + d;
    this.sftpStream.data(reqid, buffer);
    logger.info('Read from file at offset %d, length %d', offset, d);
    
  }

  _remove(reqid, path) {
    logger.info('REMOVE', path);
    fs.unlinkSync(path);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _rmdir(reqid, path){
    logger.info('RMDIR', path);
    deleteFolderRecursive(path);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _mkdir(reqid, path, attrs) {
    fs.mkdirSync(path);
    this.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }

  _readdir(reqid, handle){
    if(this.openFiles[handle] && !this.openFiles[handle].opened) {
      logger.info('READDIR', this.openFiles[handle].path);
      var names = [];

      if(this.openFiles[handle].path == '.')
        names = racine
      else 
        names = fs.readdirSync(this.openFiles[handle].path)
   
      var name = names.map((v) => modeLinux(path.join(this.openFiles[handle].path, v)));

    //  console.log(name[0])
      this.openFiles[handle].opened = true;
      this.sftpStream.name(reqid, name)
    } else {
      this.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
    }
  }

  _open(reqid, path, flags, attrs) {
    var handle = this.fetchhandle();
    flags  = flagsToString(flags);
    this.openFiles[handle] = { readed : 0 , path, flags};
    return this.sftpStream.handle(reqid, handle);
  }
  
}


module.exports = SFTP;
