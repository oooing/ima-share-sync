"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
let response, observed;
const bundle = buildSync({entryPoints:['src/native-identity-runner.ts'],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.ps1':'text'}}).outputFiles[0].text;
const mod = {exports:{}};
new Function('require','module','exports',bundle)(name => {
  if (name === 'child_process') return {spawn(file,args,options) {
    assert.equal(file,path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'));
    assert.equal(options.windowsHide,true);
    const inputPath = args[args.indexOf('-InputPath')+1];
    observed = {file,options,directory:path.dirname(inputPath),input:JSON.parse(fs.readFileSync(inputPath,'utf8'))};
    fs.writeFileSync(args[args.indexOf('-OutputPath')+1],JSON.stringify(response));
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {throw new Error('Test worker must already be completed');};
    process.nextTick(() => child.emit('close',0));
    return child;
  }};
  return require(name);
},mod,mod.exports);
const {runDesktopIdentity} = mod.exports;

test('Web native runner preserves desktop busy and locked reasons and cleans isolated output',async()=>{
  for (const [field,code] of [['busy','desktop-busy'],['locked','desktop-locked']]) {
    response = {[field]:true,errors:[]}; observed = undefined;
    await assert.rejects(runDesktopIdentity({action:'list-knowledge-bases'}),error=>error.code===code);
    assert.ok(observed); assert.equal(fs.existsSync(observed.directory),false);
  }
});

test('Web native runner forwards identity error codes instead of treating incomplete reads as absence',async()=>{
  response = {errors:[{message:'目录读取不完整'}],identityErrorCode:'incomplete'};
  await assert.rejects(runDesktopIdentity({action:'resolve',knowledgeBaseId:'10000001',folderId:'folder_201'}),error=>error.code==='incomplete'&&error.message==='目录读取不完整');
  assert.equal(fs.existsSync(observed.directory),false);
});

test('Web native runner works with only the Windows system PATH and sends no API credentials',async()=>{
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows','System32');
    response = {identityResult:[{id:'001a6dab3f807619',name:'个人库'}]};
    assert.deepEqual(await runDesktopIdentity({action:'list-knowledge-bases'}),response.identityResult);
    assert.deepEqual(observed.input,{operation:'native-identity',nativeIdentity:{action:'list-knowledge-bases'},sourceTargetKind:'knowledge-base',contentMode:'general',allowForeground:false});
    assert.equal(fs.existsSync(observed.directory),false);
  } finally { process.env.PATH = previousPath; }
});