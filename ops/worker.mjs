export function queueWorker(billing,{interval=30000,log=()=>{},now=()=>Date.now()}={}) {
  let timer,flight,stopped=false,lastSuccess=now(),lastError=null;
  function tick() {
    if(stopped||flight)return flight;
    flight=Promise.resolve().then(()=>billing.runQueue()).then(()=>{lastSuccess=now();lastError=null;},()=>{lastError='queue_unavailable';log('queue_unavailable');}).finally(()=>{flight=null;});return flight;
  }
  timer=setInterval(tick,interval);timer.unref();tick();
  return {status:()=>({ok:!lastError && now()-lastSuccess<Math.max(interval*4,120000),code:lastError}),stop:async()=>{stopped=true;clearInterval(timer);billing.stopQueue?.();await flight;}};
}
