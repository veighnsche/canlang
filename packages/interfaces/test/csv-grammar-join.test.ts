import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCsvText as advisory} from '@canlang/ui';
import {parseCsvText as authoritative, CsvParseError, CsvTooManyRowsError} from '../src/http/csv.js';

test('advisory and authoritative consumers retain raw CSV identities', () => {
  for (const text of ['', '\n', 'a,b\n', 'a,b\r\n1,2\r\n', '\ufeffname,value\nx, y\n', 'a,b\n\n', 'a,b\n1\n', 'a,b\n"one\ntwo","quoted ""value"""', 'a,b\nx\ry,z', 'a,b\nx,y\n']) {
    const client = advisory(text);
    if(client.ok) assert.deepEqual(authoritative(text), {header:client.header,rows:client.rows});
    else assert.throws(()=>authoritative(text), error=>error instanceof CsvParseError && error.message===client.error.message);
  }
});

test('authoritative wrapper preserves distinct safe parse and count failures', () => {
  for (const [text, message] of [
    ['a,b\nx"q",2','Malformed quoting in CSV text.'],
    ['a,b\n"q"x,2','Malformed quoting in CSV text.'],
    ['a,b\n\ud800,2','CSV text contains an unpaired UTF-16 surrogate.'],
    ['a,b\n"unterminated','Unterminated quoted field in CSV text.'],
  ]) {
    const client=advisory(text!); assert.equal(client.ok,false);
    assert.throws(()=>authoritative(text!),error=>error instanceof CsvParseError && error.message===message);
  }
  const tooMany='a\n'+Array.from({length:1001},()=> 'x').join('\n');
  assert.throws(()=>authoritative(tooMany),error=>error instanceof CsvTooManyRowsError && error.message==='CSV text has 1001 data rows; the limit is 1000.');
  assert.throws(()=>authoritative(tooMany+'\n"unterminated'),error=>error instanceof CsvParseError && error.message==='Unterminated quoted field in CSV text.');
});
