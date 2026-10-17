# hass-kiosk-dashboard: konfiguration och användning

## Inloggning och ingress

Tillägget exponeras endast genom Home Assistants ingress. Ingen separat värdport öppnas. Servern accepterar endast ingressproxyn på `172.30.32.2` och kräver att proxyn identifierar en inloggad användare.

Öppna tillägget via Home Assistant på varje enhet innan du använder den direkta ingressadressen. Vanlig Home Assistant-inloggning räcker inte alltid för att skapa ingress-sessionen.

Länken **Öppna utan ram ↗** i sidfoten öppnar dashboarden utan Home Assistants omgivande gränssnitt. Kioskappen måste använda samma webbläsarlagring som inloggningen. Inloggning i Chrome skapar inte automatiskt en session i en separat kioskapp.

Spara adressen från den egna installationen, inklusive sista `/`. Ingressadressen är installationsberoende och kan behöva hämtas igen om tillägget installeras om.

Om sessionen upphör kan en redan öppen dashboard visa ett sessionsmeddelande. Den kan inte själv förnya Home Assistant-inloggningen. Öppna Home Assistant via meddelandets länk och starta hass-kiosk-dashboard därifrån igen. Vid HTTP 401 på en ny sidöppning behöver du gå till Home Assistant manuellt.

## Behörigheter

Ange de Home Assistant-användarnamn som får ändra dashboardens inställningar i tilläggets **Konfiguration**:

```yaml
settings_users:
  - "DITT_ANVANDARNAMN"
```

Använd inloggningsnamnet exakt som det är registrerat, inte visningsnamnet. Spara och starta om tillägget efter en ändring. En tom lista innebär att ingen får ändra inställningarna.

Övriga inloggade användare kan visa dashboarden och styra de lampor som valts för den. Kugghjulet visas bara för användare i listan. Samma konto har samma behörighet på alla enheter.

Home Assistant uppger användaridentiteten genom betrodda ingresshuvuden. Tillägget kräver dessa huvuden. Saknas de trots ny inloggning, kontrollera stödet i din Home Assistant- och Supervisor-version.

Tillägget använder sin egen Supervisor-token för API-anrop. Lampkommandon följer dashboardens lista över valda lampor, inte en separat kontroll av varje användares Home Assistant-enhetsbehörigheter.

## Välj kalendrar, väder och lampor

1. Öppna hass-kiosk-dashboard från datorn med ett konto i `settings_users`.
2. Tryck på kugghjulet och **Anslut och hämta enheter**.
3. Välj de kalendrar, lampor och den väderentitet som ska visas.
4. Tryck **Spara för alla skärmar**.

Home Assistant-adress och PAT behöver inte anges. Servern använder `SUPERVISOR_TOKEN` mot `http://supervisor/core/api/`. Token skickas aldrig till webbläsaren och sparas inte i dashboardens inställningsfil.

Kalender- och väderintegrationer måste redan vara konfigurerade i Home Assistant. Dygnsprognosen använder `weather.get_forecasts`. Aktuellt väder visas även när integrationen saknar dygnsprognos.

## Gemensamma inställningar

- Valda kalendrar, lampor, väder och demoläge delas mellan alla skärmar.
- Skärmarna kontrollerar inställningar var 15:e sekund när sidan är synlig.
- Home Assistant-data hämtas varje minut. Lampkommandon skickas direkt.
- Vald dag, visad vecka och tillfälliga kalenderfilter är lokala för varje skärm.
- Sparade ändringar återställer de tillfälliga kalenderfiltren.
- Samtidiga ändringar från två datorer skyddas med en versionskontroll. Öppna inställningarna igen om servern avvisar en äldre ändring.

**Visa demo på alla skärmar** sparar ett gemensamt demoläge. De valda enheterna behålls. Hämta enheter och spara igen för att återgå till riktiga data.

## Lagring och uppdatering

Dashboardens inställningar sparas i `/data/settings.json` i tilläggets privata, beständiga lagring. Tilläggets användarlista kommer från `/data/options.json`, som Supervisor hanterar.

Inställningarna bevaras när tillägget startas om eller uppdateras. Ta med tilläggets data i Home Assistant-säkerhetskopior. Avinstallation med borttagning av data raderar inställningarna.

Vid uppdatering av ett lokalt tillägg ersätter du källfilerna i `/addons/hass-kiosk-dashboard/` och bygger om via Home Assistants tilläggshantering. Vid egna versioner höjer du `version` i `config.yaml` och `package.json`.

## Äldre Android

Dashboarden använder ES5-JavaScript, `XMLHttpRequest` och Flexbox. Den använder inte moduler, `fetch`, promises, CSS Grid eller CSS-variabler. Målnivån är Android 4.4:s Chromium-baserade WebView och senare.

Home Assistants egna inloggnings- och startvyer måste fungera i den valda webbläsaren eller kioskappen. Dashboardens kompatibilitet ändrar inte deras krav. Testa även tabletens stöd för Home Assistants HTTPS-certifikat.

Använd liggande helskärmsläge med 1024 × 600 tillgängliga CSS-pixlar. Fler händelser rullas i dagvyn och fler än tre lampor rullas i sidled.

## Felsökning

- **Inget kugghjul:** kontrollera inloggningsnamnet i `settings_users` och starta om tillägget.
- **HTTP 401 eller sessionsmeddelande:** öppna hass-kiosk-dashboard via Home Assistant i samma webbläsare eller kioskapp.
- **HTTP 403 från tilläggets server:** direktanslutning till containern tillåts inte. Använd ingress.
- **Saknade skript eller API-fel:** kontrollera att ingressadressen slutar med `/` och att alla filer hör till samma version.
- **Home Assistant-anrop misslyckas:** kontrollera tilläggets logg och att `homeassistant_api: true` finns kvar i manifestet.
- **Inga kalenderhändelser:** kontrollera vald dag och kalenderfilter. Kontrollera sedan kalenderintegrationerna i Home Assistant.
- **Ingen prognos:** integrationen kan sakna stöd för dygnsprognos.

## Tekniska referenser

- [Home Assistant ingress](https://contributors.home-assistant.io/apps/guides/ingress/)
- [API-kommunikation och Supervisor-token](https://contributors.home-assistant.io/apps/guides/communication/)
- [Tilläggskonfiguration](https://contributors.home-assistant.io/apps/reference/configuration/)
