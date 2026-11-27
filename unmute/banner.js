const {createCanvas}=require("@napi-rs/canvas");

function renderUnmuteBanner(){
  const canvas=createCanvas(1280,430),ctx=canvas.getContext("2d");
  ctx.save();ctx.beginPath();ctx.roundRect(0,0,1280,430,28);ctx.clip();
  const sky=ctx.createLinearGradient(0,0,1100,430);
  sky.addColorStop(0,"#080d1c");sky.addColorStop(.48,"#101d3c");sky.addColorStop(1,"#182552");
  ctx.fillStyle=sky;ctx.fillRect(0,0,1280,430);
  for(const [x,y,r,color]of [[940,80,460,"rgba(0,108,252,.34)"],[320,190,390,"rgba(105,111,255,.16)"],[1120,300,330,"rgba(79,185,255,.17)"]]){
    const fog=ctx.createRadialGradient(x,y,0,x,y,r);fog.addColorStop(0,color);fog.addColorStop(1,"rgba(4,9,24,0)");
    ctx.fillStyle=fog;ctx.fillRect(0,0,1280,430);
  }
  const mountain=(points,color)=>{ctx.beginPath();ctx.moveTo(...points[0]);for(let i=1;i<points.length;i++)ctx.lineTo(...points[i]);ctx.closePath();ctx.fillStyle=color;ctx.fill();};
  mountain([[0,245],[105,155],[215,235],[360,120],[535,255],[700,146],[855,248],[1035,136],[1280,246],[1280,430],[0,430]],"#111a35");
  mountain([[0,294],[180,218],[330,290],[510,204],[690,306],[865,224],[1040,290],[1185,208],[1280,254],[1280,430],[0,430]],"#0b142b");
  // Silhuetas de pinheiros em planos para formar uma paisagem fria e discreta.
  for(let layer=0;layer<2;layer++)for(let i=0;i<20;i++){
    const x=i*75-18+(layer?27:0),base=430,height=92+((i*47+layer*31)%105);
    ctx.fillStyle=layer?"#080f22":"#0b1329";ctx.beginPath();ctx.moveTo(x,base-height);ctx.lineTo(x-32,base-18);ctx.lineTo(x-13,base-22);
    ctx.lineTo(x-40,base-55);ctx.lineTo(x-20,base-54);ctx.lineTo(x-47,base-87);ctx.lineTo(x,base-height-20);
    ctx.lineTo(x+47,base-87);ctx.lineTo(x+20,base-54);ctx.lineTo(x+40,base-55);ctx.lineTo(x+13,base-22);ctx.lineTo(x+32,base-18);ctx.closePath();ctx.fill();
  }
  const road=ctx.createLinearGradient(0,255,0,430);road.addColorStop(0,"rgba(89,141,255,.04)");road.addColorStop(1,"rgba(79,130,255,.25)");
  ctx.beginPath();ctx.moveTo(559,430);ctx.lineTo(624,260);ctx.lineTo(654,260);ctx.lineTo(738,430);ctx.closePath();ctx.fillStyle=road;ctx.fill();
  const haze=ctx.createLinearGradient(0,180,0,340);haze.addColorStop(0,"rgba(152,185,255,.02)");haze.addColorStop(.5,"rgba(154,188,255,.12)");haze.addColorStop(1,"rgba(152,185,255,0)");
  ctx.fillStyle=haze;ctx.fillRect(0,170,1280,170);
  ctx.strokeStyle="rgba(178,201,255,.23)";ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(16,16,1248,398,22);ctx.stroke();
  ctx.textAlign="center";ctx.textBaseline="middle";ctx.shadowColor="rgba(0,108,252,.55)";ctx.shadowBlur=28;
  ctx.fillStyle="#f3f6ff";ctx.font="700 112px Segoe UI, sans-serif";ctx.fillText("unmute",640,202);
  ctx.shadowBlur=9;ctx.fillStyle="#a9c3ff";ctx.font="600 34px Segoe UI, sans-serif";ctx.letterSpacing="9px";ctx.fillText("over",640,283);
  ctx.restore();return canvas.toBuffer("image/png");
}
module.exports={renderUnmuteBanner};
