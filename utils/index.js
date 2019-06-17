"use strict";

const path      = require('path');
const execFile = require('child_process').execFile;


const getLogicalDisks = async () => {
  let logicaldisk = await new Promise((resolve, reject) => {
    execFile('wmic', ['logicaldisk', 'get', 'caption'], (err, body) => {
      if(err)
        return reject(err);
      resolve(body);
    });
  });
  return logicaldisk.split("\n").map(l => l.trim()).splice(1).filter(Boolean);
};

function wslpath(winpath) {
  if(winpath == '/')
    return '/';
  //let tmp = path.normalize(winpath); //win
  let tmp = winpath;
  var sepa = tmp.split(path.sep);
  var newS = [sepa[0].toLowerCase().replace(":", ""), ...sepa.slice(1)];
  var newP = "/" + path.posix.join(...newS);
  return newP;
}


function winpath(wslpath) {
  wslpath = path.posix.normalize(wslpath);
  if(!(wslpath[0] == "/")) //   relative
    return path.normalize(wslpath); //  foo\de\bar

  if(wslpath == '/')
    return '/';

  var sepa = wslpath.split(path.posix.sep).slice(1);
  let drive = sepa.shift().toUpperCase() + ':\\';
  let newP = drive + sepa.join(path.win32.sep);
  return newP;
}

module.exports = {getLogicalDisks, wslpath, winpath};
