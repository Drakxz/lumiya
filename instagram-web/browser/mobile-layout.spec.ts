import {test,expect} from "../frontend/node_modules/@playwright/test/index.mjs";

for(const width of [320,390]){
  test(`public mobile smoke ${width}px`,async({page})=>{
    test.skip(!process.env.MOBILE_LIVE_URL,"Run explicitly against the deployed site.");
    await page.setViewportSize({width,height:844});
    await page.goto(process.env.MOBILE_LIVE_URL!);
    await expect(page.locator(".landing-hero")).toBeVisible({timeout:20000});
    await expect(page.locator(".hero-copy").getByRole("link",{name:"Entrar com Discord"})).toBeVisible();
    await expect.poll(()=>page.locator(".moment-photo img").evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:test.info().outputPath(`aws-login-${width}.png`),fullPage:true});
  });
}

for(const width of [320,360,390,768,844,1440]){
  test(`mobile layout ${width}px`,async({page,context})=>{
    test.setTimeout(90000);
    await page.setViewportSize({width,height:width===844?390:844});
    const sessions=["browser-test-only-session","browser-test-only-mobile-session","browser-test-only-navigation-session","browser-test-only-profile-session"];
    const session=sessions[[320,360,390,768,844,1440].indexOf(width)%sessions.length];
    await context.addCookies([{name:"iw_session",value:session,url:"http://127.0.0.1:3111",httpOnly:true,sameSite:"Lax"}]);
    // Test-only image: exercises the photo frame without posting to Discord.
    await page.route("**/api/me/latest-photo*",route=>route.fulfill({status:302,headers:{location:"/profile-banner.png"}}));
    if(width===320){
      await page.route("**/api/guilds",async route=>{
        const response=await route.fetch(),data=await response.json();
        data.items=data.items.map((g:any)=>g.name==="GRIFE"?{...g,name:"GRIFE — Comunidade de fotografias e criadores com nome comprido"}:g);
        await route.fulfill({response,json:data});
      });
    }
    async function inspect(name:string){
      const overflow=await page.evaluate(()=>({
        width:innerWidth,scroll:document.documentElement.scrollWidth,
        elements:[...document.querySelectorAll("body *")].filter(el=>{
          const r=el.getBoundingClientRect();
          return r.width>0&&r.right>innerWidth+1&&!el.closest(".table-wrap,.saved-photo-gallery");
        }).slice(0,12).map(el=>el.className)
      }));
      console.log(width,name,JSON.stringify(overflow));
      await page.screenshot({path:test.info().outputPath(`${name}-${width}.png`),fullPage:true});
      expect.soft(overflow.scroll,`${name}: horizontal overflow`).toBeLessThanOrEqual(width+1);
    }
    async function navigate(label:string){
      const menu=page.getByRole("button",{name:"Abrir menu"});
      if(await menu.isVisible())await menu.click();
      await page.locator(".sidebar nav").getByRole("button",{name:new RegExp("^"+label)}).click();
    }
    await page.goto("/");
    await expect(page.locator(".landing-hero")).toBeVisible();
    await inspect("login");
    await page.goto("/app");
    await expect(page.getByRole("heading",{name:"Onde você quer postar?"})).toBeVisible();
    await inspect("servers");
    await page.getByRole("button",{name:/^Escolher GRIFE/}).click();
    await expect(page.locator(".dashboard-hero")).toBeVisible();
    await expect(page.locator(".dashboard-photo img")).toBeVisible();
    if(width<=800){
      const art=await page.locator(".dashboard-art").boundingBox();
      const hero=await page.locator(".dashboard-hero").boundingBox();
      expect(art!.x).toBeGreaterThanOrEqual(hero!.x);
      expect(art!.x+art!.width).toBeLessThanOrEqual(hero!.x+hero!.width);
      await expect(page.locator(".dashboard-art")).toHaveCSS("opacity","1");
      const menu=page.getByRole("button",{name:"Abrir menu"});
      await menu.click();
      await expect(page.getByRole("button",{name:"Fechar menu"})).toBeFocused();
      await page.getByRole("button",{name:"Fechar menu"}).click();
      await expect(menu).toHaveAttribute("aria-expanded","false");
      await menu.click();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await menu.click();
      await page.locator(".mobile-nav-backdrop").click({position:{x:width-10,y:400}});
      await expect(menu).toHaveAttribute("aria-expanded","false");
      expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe("hidden");
    }
    await inspect("dashboard");
    await navigate("Nova publicação");
    await expect(page.locator(".composer")).toBeVisible();
    await inspect("composer");
    await navigate("Minhas publicações");
    await expect(page.getByRole("heading",{name:"Minhas publicações",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Denunciar por ID",exact:true}).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await inspect("dialog");
    await page.getByRole("button",{name:"Fechar",exact:true}).click();
    await navigate("Meu perfil");
    await expect(page.locator(".profile-showcase")).toBeVisible();
    await inspect("profile");
    await navigate("Administração");
    await expect(page.getByRole("heading",{name:"Administração",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Configurações",exact:true}).click();
    await expect(page.getByRole("button",{name:"Salvar configurações",exact:true})).toBeVisible();
    await inspect("settings");
    await page.getByRole("button",{name:"Publicações",exact:true}).click();
    await expect(page.locator(".table-wrap")).toBeVisible();
    await inspect("admin-table");
  });
}
