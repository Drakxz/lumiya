function createLimiter(max=4,maxWaiting=50){
  let active=0;const waiting=[];
  function drain(){while(active<max&&waiting.length){const {task,resolve,reject}=waiting.shift();active++;Promise.resolve().then(task).then(resolve,reject).finally(()=>{active--;drain();});}}
  return task=>new Promise((resolve,reject)=>{if(waiting.length>=maxWaiting)return reject(new Error("Limite de processamento atingido"));waiting.push({task,resolve,reject});drain();});
}
module.exports={createLimiter};
