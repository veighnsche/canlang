// Playwright API forwarding. Rust owns browser plans, checks and all resource IDs.
function locator(page,p){
  let value=page.locator(p.selector);
  for(const step of p.chain??[]){
    if(step.selector!==undefined)value=value.locator(step.selector);
    else if(step.hasText!==undefined)value=value.filter({hasText:step.hasText});
    else if(step.first===true)value=value.first();
    else if(step.nth!==undefined)value=value.nth(step.nth);
    else throw Error('unknown locator API operation');
  }
  return value;
}
async function response(value){let json=null;try{json=await value.json();}catch{}return {status:value.status(),json,url:value.url()};}
export async function call(command,p,parent,signal,r){
  const get=(id,kind)=>r.find(parent,id,kind).value;
  signal.throwIfAborted();
  switch(command){
    case 'browser.executable':{const driver=r.require(p.driverEntryPath);return {executablePath:driver.chromium.executablePath()};}
    case 'browser.launch':{const entry=r.allocate(parent,p.handle,'browser');const driver=r.require(p.identity.driverEntryPath);entry.value=await driver.chromium.launch({headless:true,executablePath:p.identity.executablePath,timeout:p.timeout??30000});return {identity:p.identity};}
    case 'browser.newContext':{const entry=r.allocate(parent,p.handle,'context');entry.value=await get(p.browser,'browser').newContext();entry.value.setDefaultTimeout(p.timeout??10000);entry.value.setDefaultNavigationTimeout(p.navigationTimeout??15000);return null;}
    case 'browser.newPage':{const entry=r.allocate(parent,p.handle,'page');entry.value=await get(p.context,'context').newPage();return null;}
    case 'browser.goto':{const value=await get(p.page,'page').goto(p.url,{waitUntil:'domcontentloaded'});return value?response(value):{status:null,json:null};}
    case 'browser.request':{const client=get(p.context,'context').request;const method=p.method.toLowerCase();if(!['get','post'].includes(method))throw Error('unsupported browser request method');return response(await client[method](p.url,{headers:p.headers,data:p.data,timeout:p.timeout??10000}));}
    case 'browser.cookies':return get(p.context,'context').cookies();
    case 'browser.title':return get(p.page,'page').title();
    case 'browser.locator':{
      const value=locator(get(p.page,'page'),p);
      if(['count','allTextContents','innerText','inputValue','isChecked'].includes(p.method))return value[p.method]();
      if(['fill','setChecked'].includes(p.method)){await value[p.method](p.value);return null;}
      if(p.method==='waitFor'){await value.waitFor(p.options??{state:'visible'});return null;}
      if(['check','click'].includes(p.method)){await value[p.method](p.options??{});return null;}throw Error('unsupported locator method');
    }
    case 'browser.submit':{
      const page=get(p.page,'page'),form=locator(page,p);
      const expected=p.path??`/api/operations/${p.operation}`;
      const waiting=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname===expected);
      const [value]=await Promise.all([waiting,form.locator('button[type="submit"]').first().click()]);return response(value);
    }
    case 'browser.close':{const entry=r.resources.get(p.handle);if(entry){if(entry.parent!==parent)throw Error('foreign browser resource');await r.dispose(entry);}return {released:true,connected:false};}
    default:throw Error('unknown browser SDK operation');
  }
}
