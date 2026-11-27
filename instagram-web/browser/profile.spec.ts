import {test,expect} from "../frontend/node_modules/@playwright/test/index.mjs";
import type {Page,BrowserContext} from "../frontend/node_modules/@playwright/test/index.mjs";

async function openProfile(page:Page,context:BrowserContext,token:string){
  await context.addCookies([{name:"iw_session",value:token,url:"http://127.0.0.1:3111",httpOnly:true,sameSite:"Lax"}]);
  await page.goto("/app");
  await page.getByRole("button",{name:"Escolher GRIFE",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Olá, Camila."})).toBeVisible();
  if(await page.getByRole("button",{name:"Abrir menu"}).isVisible())await page.getByRole("button",{name:"Abrir menu"}).click();
  await page.locator(".sidebar").getByRole("button",{name:"Meu perfil",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Meu perfil",exact:true})).toBeVisible();
}

test("profile displays real banner, badges and roles and preserves preference saving",async({page,context})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await openProfile(page,context,"browser-test-only-profile-session");
  await expect(page.getByRole("img",{name:"Banner do perfil de Camila"})).toBeVisible();
  await expect.poll(()=>page.locator(".profile-cover-image").evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  const badges=page.locator(".profile-badge-list");
  const accountBadges=page.getByRole("group",{name:"Insígnias da conta Discord",exact:true});
  await expect(accountBadges.getByRole("img",{name:"Brilliance",exact:true})).toBeVisible();
  await expect(accountBadges.locator(".discord-account-badge")).toHaveCount(4);
  await expect(accountBadges.getByRole("img",{name:"Brilliance",exact:true})).toHaveAttribute("title",/Casa Brilliance do HypeSquad/);
  await expect(accountBadges.getByText("Administrador",{exact:true})).toHaveCount(0);
  for(const name of ["Membro da comunidade","Administrador","Impulsionador","Brilliance","Apoiador inicial","Nitro"])await expect(badges.getByText(name,{exact:true})).toBeVisible();
  for(const name of ["Brilliance","Apoiador inicial","Nitro","Boost neste servidor"]){
    const image=accountBadges.getByRole("img",{name,exact:true}).locator("img");
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(accountBadges.getByRole("img",{name:"Boost neste servidor",exact:true})).toHaveAttribute("title",/não informa o nível global/);
  await expect(page.locator(".profile-role-list").getByText("Criadores",{exact:true})).toBeVisible();
  await expect(page.locator(".profile-meta")).toContainText("2020");
  await page.getByRole("textbox",{name:"Instagram padrão",exact:true}).fill(`camila.${test.info().project.name}`);
  await page.getByRole("switch",{name:"Sugerir meu Instagram em novas publicações",exact:true}).check();
  await page.getByRole("switch",{name:"Notificações internas",exact:true}).uncheck();
  await page.getByRole("button",{name:"Salvar preferências",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("Preferências salvas.");
  const response=await page.request.get("/api/profile?guildId=100000000000000001");
  expect(response.ok()).toBe(true);
  expect((await response.json()).preferences).toMatchObject({handle:`camila.${test.info().project.name}`,showInstagram:true,notifications:false});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("profile.png"),fullPage:true});
  await page.route("**/profile-banner.png",route=>route.abort());
  const failedImage=page.waitForEvent("requestfailed",{predicate:r=>new URL(r.url()).pathname==="/profile-banner.png"});
  await openProfile(page,context,"browser-test-only-profile-session");
  await failedImage;
  await expect(page.locator(".profile-cover-image")).toHaveCount(0);
  await expect(page.locator(".profile-cover.has-image")).toHaveCount(0);
  await expect(page.getByRole("textbox",{name:"Instagram padrão",exact:true})).toHaveValue(`camila.${test.info().project.name}`);
  expect(errors).toEqual([]);
});

test("profile renders native Discord badge artwork from the optional visual lookup",async({page,context})=>{
  // Deterministic 1x1 PNG standing in for the CDN artwork; the URL shape is what matters here.
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
  await page.route("https://cdn.discordapp.com/badge-icons/**",route=>route.fulfill({status:200,contentType:"image/png",body:png}));
  await openProfile(page,context,"browser-test-only-visual-session");
  const accountBadges=page.getByRole("group",{name:"Insígnias da conta Discord",exact:true});
  await expect(accountBadges.locator(".discord-account-badge")).toHaveCount(3);
  for(const name of ["Discord Nitro","Early Supporter","Nitro há 1 mês"]){
    const image=accountBadges.getByRole("img",{name,exact:true}).locator("img");
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator(".profile-badge-list")).toContainText("Discord Nitro");
  await expect(page.locator(".profile-badge-list li")).toHaveCount(4);
  await expect(page.getByText(/Insígnias visíveis para a conta de consulta/)).toBeVisible();
  await expect(page.locator(".profile-badge-list").getByText("Administrador",{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("profile-visual-badges.png"),fullPage:true});
});

test("ordinary profile uses decorative cover without inventing privileged badges or roles",async({page,context})=>{
  await openProfile(page,context,"browser-test-only-member-session");
  await expect(page.locator(".profile-cover-art")).toBeVisible();
  await expect(page.locator(".profile-badge-list").getByText("Membro da comunidade",{exact:true})).toBeVisible();
  await expect(page.locator(".profile-badge-list li")).toHaveCount(1);
  await expect(page.getByRole("group",{name:"Insígnias da conta Discord",exact:true})).toContainText("Sem insígnias públicas");
  await expect(page.locator(".discord-account-badge")).toHaveCount(0);
  await expect(page.getByText("Você ainda não tem cargos adicionais neste servidor.",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Revogar todas as sessões",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("profile-fallback.png"),fullPage:true});
});
