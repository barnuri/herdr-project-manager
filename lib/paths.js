'use strict';

const os = require('node:os');
const path = require('node:path');

function expandHomePath(rawPath) {
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

module.exports = { expandHomePath };
