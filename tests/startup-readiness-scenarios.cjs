"use strict";
const path = require("node:path");

// Exercise the actual bundled plugin, with only time, Windows status and IMA output isolated.
module.exports = async ({assert,scenario,loadFixture,storedFixture,clone,deferred,flush,EventEmitter,setSpawnFixture}) => {
  const timerSet = window.setTimeout, timerClear = window.clearTimeout;
  let timers, now, nextId;
  const clock = () => {
    timers = new Map(); now = 0; nextId = 1;
    window.setTimeout = (callback, delay) => { const id = nextId++; timers.set(id,{callback,at:now+delay}); return id; };
    window.clearTimeout = id => timers.delete(id);
  };
  const advance = async ms => {
    now += ms;
    for (const [id,timer] of [...timers]) if(timer.at<=now) { timers.delete(id); timer.callback(); }
    for(let i=0;i<30;i++) await flush();
  };
  const fixture = async () => {
    const plugin = await loadFixture({...storedFixture(),autoSync:true});
    let cards=0,extracts=0;
    plugin.openOperationCard = async () => { cards++; return null; };
    plugin.runPowerShell = async () => { extracts++; return JSON.stringify({items:[],errors:[],skippedTitles:[]}); };
    return {plugin,effects:()=>({cards,extracts,created:plugin.created.length,modified:plugin.modified.length})};
  };
  try {
    await scenario("startup waits silently while locked, then runs once after the desktop becomes available",async()=>{
      clock(); const {plugin,effects}=await fixture(); let ready=false,probes=0;
      plugin.checkDesktopReady=async()=>{probes++;return ready;};
      const saved=clone(plugin.savedData),saveCalls=plugin.saveCalls;
      plugin.layoutReady(); await advance(10000); await advance(30000);
      assert.equal(probes,2); assert.deepEqual(effects(),{cards:0,extracts:0,created:0,modified:0});
      assert.deepEqual(plugin.savedData,saved); assert.equal(plugin.saveCalls,saveCalls); assert.equal(plugin.syncReports.length,0);
      ready=true; await advance(30000);
      assert.equal(effects().cards,1); assert.equal(effects().extracts,1);
      assert.equal(plugin.syncReports.length,1); assert.equal(plugin.syncReports[0].status,"success");
      assert.deepEqual(plugin.syncedAttachments,saved.syncedAttachments);
      assert.equal(plugin.settings.sourceBinding.localDestination,saved.sourceBinding.localDestination);
      await advance(60000); assert.equal(effects().extracts,1); plugin.onunload();
    });
    await scenario("unknown Windows status waits without a failure report or any IMA action",async()=>{
      clock(); const {plugin,effects}=await fixture(); plugin.checkDesktopReady=async()=>{throw new Error("Status unavailable");};
      await plugin.tryAutomaticSync(); assert.equal(effects().extracts,0); assert.equal(effects().cards,0);
      assert.equal(plugin.syncReports.length,0); assert.equal(timers.size,1); plugin.onunload(); assert.equal(timers.size,0);
    });
    await scenario("focus and retry cannot start overlapping desktop checks or duplicate syncs",async()=>{
      clock(); const {plugin,effects}=await fixture(); const pending=deferred(); let probes=0;
      plugin.checkDesktopReady=()=>{probes++;return pending.promise;};
      plugin.scheduleDeferredSync(false); const first=plugin.tryAutomaticSync();
      plugin.domCallbacks.get("focus")(); await plugin.tryAutomaticSync(); assert.equal(probes,1);
      pending.resolve(true); await first; assert.equal(effects().extracts,1); assert.equal(timers.size,0); plugin.onunload();
    });
    for(const change of ["disable","unload"]){
      await scenario(`${change} during the desktop check prevents a late automatic sync`,async()=>{
        clock(); const {plugin,effects}=await fixture(); const pending=deferred(); plugin.checkDesktopReady=()=>pending.promise;
        const run=plugin.tryAutomaticSync(); if(change==="disable")plugin.settings.autoSync=false; else plugin.onunload();
        pending.resolve(true); await run; assert.equal(effects().extracts,0); assert.equal(effects().cards,0); assert.equal(timers.size,0);
        plugin.onunload();
      });
    }
    await scenario("disabling auto-sync cancels the effect of an already scheduled retry",async()=>{
      clock(); const {plugin,effects}=await fixture(); let probes=0; plugin.checkDesktopReady=async()=>{probes++;return false;};
      await plugin.tryAutomaticSync(); plugin.settings.autoSync=false; await advance(30000);
      assert.equal(probes,1); assert.equal(effects().extracts,0); assert.equal(timers.size,0); plugin.onunload();
    });
    await scenario("an active manual sync prevents the automatic probe from starting another run",async()=>{
      clock(); const {plugin,effects}=await fixture(); const pending=deferred(); plugin.checkDesktopReady=()=>pending.promise;
      const run=plugin.tryAutomaticSync(); plugin.running=true; pending.resolve(true); await run;
      assert.equal(effects().extracts,0); plugin.running=false; plugin.onunload();
    });
    window.setTimeout=timerSet;window.clearTimeout=timerClear;
    for(const [name,stdout,code,expected] of [
      ["ready",'{"desktopReady":true}',0,true], ["locked",'{"desktopReady":false}',0,false],
      ["malformed","bad output",0,false], ["unknown",'{}',0,false], ["string boolean",'{"desktopReady":"true"}',0,false],
      ["process failure",'{"desktopReady":true}',1,false],
    ]){
      await scenario(`read-only native probe handles ${name}`,async()=>{
        const {plugin}=await fixture();
        setSpawnFixture((file,args)=>{
          assert.equal(file,path.join(process.env.SystemRoot || "C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"));assert.ok(args.includes("-CheckDesktop"));assert.ok(!args.includes("-InputPath"));
          const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=()=>{};
          process.nextTick(()=>{child.stdout.emit("data",stdout);child.emit("close",code);});return child;
        });
        assert.equal(await plugin.checkDesktopReady(),expected); setSpawnFixture(null);plugin.onunload();
      });
    }
    for(const action of ["timeout","unload"]){
      await scenario(`native probe ${action} terminates the status process and never starts IMA`,async()=>{
        clock();const {plugin,effects}=await fixture();const started=deferred();let killed=false;
        setSpawnFixture(()=>{
          const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=()=>{};
          child.kill=()=>{killed=true;process.nextTick(()=>child.emit("close",1));};started.resolve();return child;
        });
        const run=plugin.tryAutomaticSync();await started.promise;
        if(action==="timeout")await advance(10000);else plugin.onunload();
        await run;assert.equal(killed,true);assert.equal(effects().extracts,0);assert.equal(effects().cards,0);
        setSpawnFixture(null);plugin.onunload();assert.equal(timers.size,0);
      });
    }
  } finally {window.setTimeout=timerSet;window.clearTimeout=timerClear;setSpawnFixture(null);}
};
