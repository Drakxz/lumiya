import {test,expect} from "../frontend/node_modules/@playwright/test/index.mjs";

test("administration can switch between statistics, lists and settings without blanking the page",async({page,context})=>{
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await context.addCookies([{name:"iw_session",value:"browser-test-only-navigation-session",url:"http://127.0.0.1:3111",httpOnly:true,sameSite:"Lax"}]);
  await page.goto("/app");
  await page.getByRole("button",{name:"Escolher GRIFE",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Olá, Camila."})).toBeVisible();
  if(await page.getByRole("button",{name:"Abrir menu"}).isVisible())await page.getByRole("button",{name:"Abrir menu"}).click();
  await page.getByRole("button",{name:"Administração",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Operação real",exact:true})).toBeVisible();
  for(const [label,path] of [["Publicações","publications"],["Membros","users"],["Denúncias","reports"],["Auditoria","logs"],["Configurações","guilds/100000000000000001/settings"],["Visão geral","stats"],["Publicações","publications"]]){
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/admin/${path}`);
    await page.getByRole("button",{name:label,exact:true}).click();
    await response;
    await expect(page.getByRole("heading",{name:"Administração",exact:true})).toBeVisible();
    if(label==="Configurações")await expect(page.getByRole("combobox",{name:"Canal de Instagram",exact:true})).toBeVisible();
    else if(label==="Visão geral")await expect(page.getByRole("heading",{name:"Operação real",exact:true})).toBeVisible();
    else await expect(page.locator(".table-wrap")).toBeVisible();
  }
  // A slow response from an old tab must not replace the current list.
  await page.getByRole("button",{name:"Visão geral",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Operação real",exact:true})).toBeVisible();
  let release!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{started=resolve;});
  const publications="**/api/admin/publications?*";
  await page.route(publications,async route=>{
    started();await held;
    await route.fulfill({json:{items:[{id:"old-response",caption:"Resposta antiga de publicações",state:"published",createdAt:Date.now()}]}});
  });
  try{
    await page.getByRole("button",{name:"Publicações",exact:true}).click();
    await requested;
    const members=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/admin/users");
    await page.getByRole("button",{name:"Membros",exact:true}).click();
    await members;
    await expect(page.locator(".table-wrap")).toBeVisible();
    const oldResponse=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/admin/publications");
    release();await oldResponse;
    await expect(page.locator(".tabs .active")).toHaveText("Membros");
    await expect(page.getByRole("cell",{name:"camila",exact:true}).first()).toBeVisible();
    await expect(page.getByText("Resposta antiga de publicações",{exact:true})).toHaveCount(0);
  }finally{release();await page.unroute(publications);}
  // Both HTTP failures and unexpected response shapes remain recoverable.
  for(const response of [{status:503,json:{error:"Serviço temporariamente indisponível."}},{status:200,json:{states:[]}}]){
    await page.route(publications,route=>route.fulfill(response));
    await page.getByRole("button",{name:"Publicações",exact:true}).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading",{name:"Administração",exact:true})).toBeVisible();
    await page.unroute(publications);
    await page.getByRole("button",{name:"Tentar novamente",exact:true}).click();
    await expect(page.locator(".table-wrap")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button",{name:"Membros",exact:true}).click();
    await expect(page.getByRole("cell",{name:"camila",exact:true}).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
