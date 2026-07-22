const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('crypto');
function sha256(b){return crypto.createHash('sha256').update(b).digest('hex')}
test('snapshot checksum changes when data changes',()=>{const a=Buffer.from('SQLite format 3\0abc'),b=Buffer.from('SQLite format 3\0abd');assert.notEqual(sha256(a),sha256(b))});
test('snapshot header identifies SQLite files',()=>{const b=Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(100)]);assert.equal(b.subarray(0,16).toString(),'SQLite format 3\0')});
