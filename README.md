# hass-kiosk-dashboard

En svensk Home Assistant-dashboard för en äldre 7-tums Android-surfplatta, 1024 × 600 i liggande läge.

- Veckokalender med dagvy, flera kalendrar och färgkodade filter.
- Aktuellt väder och fyra dagars prognos när integrationen stöder det.
- Belysning med av/på, dimring och ”Släck alla”.
- Gemensamma inställningar från datorn. Surfplattan hämtar ändringar inom 15 sekunder.
- Home Assistant-tillägg med ingress och automatisk API-autentisering. Ingen PAT behövs.
- Vanlig HTML, CSS och ES5-JavaScript utan externa resurser eller byggsteg.

## Installera från Git-repository

1. Öppna Home Assistants tilläggsbutik.
2. Välj **⋮ → Repositories** och lägg till `https://github.com/danieloldberg/hass-kiosk-dashboard`.
3. Installera **hass-kiosk-dashboard** från den nya repositorysektionen.
4. Ange desktopkontots inloggningsnamn i `settings_users`, starta tillägget och öppna webbgränssnittet.

Home Assistant bygger avbildningen på värden. Ingen separat containerregistry behövs.

## Installera som lokalt tillägg

Kräver en Home Assistant-installation med stöd för tillägg, exempelvis Home Assistant OS.

1. Kopiera undermappen `hass-kiosk-dashboard/` till `/addons/hass-kiosk-dashboard/` på Home Assistant-värden via exempelvis Samba eller SSH. Detta är **inte** `/config/www/`.
2. Kontrollera att `/addons/hass-kiosk-dashboard/config.yaml` och `/addons/hass-kiosk-dashboard/Dockerfile` finns direkt i mappen.
3. Uppdatera listan i Home Assistants tilläggsbutik. Installera **hass-kiosk-dashboard** under lokala tillägg. Första installationen bygger containeravbildningen.
4. Ange ditt desktopkontos Home Assistant-användarnamn under **Konfiguration**:

   ```yaml
   settings_users:
     - "DITT_ANVANDARNAMN"
   ```

5. Starta tillägget. Öppna dess webbgränssnitt från datorn.
6. Tryck på kugghjulet, välj **Anslut och hämta enheter**, välj enheter och spara.

Använd det faktiska inloggningsnamnet, inte kontots visningsnamn. Starta om tillägget efter ändringar i `settings_users`.

## Öppna på surfplattan

1. Logga in i Home Assistant i surfplattans webbläsare eller kioskapp.
2. Öppna hass-kiosk-dashboard via Home Assistant en gång för att skapa en ingress-session.
3. Tryck **Öppna utan ram ↗** längst ned i dashboarden.
4. Använd den resulterande adressen som kioskadress. Behåll det avslutande snedstrecket.

Adressen liknar `https://DIN-HA/api/hassio_ingress/<ingress-token>/`. Använd adressen från din installation. Den visar enbart dashboarden.

En separat surfplatteanvändare kan visa dashboarden och styra valda lampor utan att finnas i `settings_users`. Delar surfplattan desktopkontot får den samma rätt att ändra inställningar.

Vid utgången session visar en redan öppen dashboard ett meddelande och stänger av lampkontrollerna. Öppna tillägget via Home Assistant igen. En direktadress utan giltig ingress-session kan ge HTTP 401 innan dashboarden laddas.

Se [DOCS.md](hass-kiosk-dashboard/DOCS.md) för lagring, behörigheter och felsökning.

## Kör fristående för utveckling

Node.js 22 eller senare krävs. Inga npm-paket behövs för servern:

```sh
export HEMMA_ADMIN_KEY='din-langa-slumpmassiga-administratornyckel'
npm start
```

Öppna `http://localhost:8080`. Fristående läge använder en serverlagrad Home Assistant-token och administratörsnyckeln i inställningarna. Det läget har inte ingress-autentisering; dashboard och valda lampkontroller är tillgängliga för alla som når servern.

`HOST`, `PORT` och `HEMMA_DATA_DIR` ändrar lyssningsadress, port och lagringsmapp. Standard är `0.0.0.0`, `8080` och `hass-kiosk-dashboard/data/`.

## Tester

```sh
npm install
npx playwright install chromium
npm test
```

Testerna verifierar ES5-syntax, 1024 × 600-layout, desktop–surfplatta-synkronisering, lampkommandon och beständig lagring. En simulerad ingressproxy kontrollerar relativa sökvägar, användarbehörigheter, Supervisor-autentisering och sessionsfel.

Containerbygget, den verkliga Home Assistant-installationen och den gamla surfplattan behöver också verifieras i målmiljön.
