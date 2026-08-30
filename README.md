# LMAA Extension

Eine persönliche Chrome-Erweiterung, die aus YouTube-Videos kompakte Briefings erzeugt. Sie übernimmt einen YouTube-Link, lädt verfügbare Untertitel direkt im Browser oder optional über einen konfigurierbaren RapidAPI-Provider und erzeugt das Briefing über die OpenAI Responses API mit exakt `gpt-5.6-sol`.

Die Extension ist ein eigenständiger Browser-Port des Android-Projekts [MartinRJ/LMAA](https://github.com/MartinRJ/LMAA). Das Hauptprojekt bleibt die Referenz für Produktidee, Sicherheitsgrenzen, Providerverhalten und Briefing-Stile; diese Extension benötigt die Android-App jedoch nicht.

## Funktionen

- YouTube-Links als `watch`, `youtu.be`, `shorts`, `live` und `embed` erkennen und auf eine validierte elfstellige Video-ID normalisieren
- Titel und Kanal über YouTube oEmbed laden
- Untertitel direkt über YouTubes Innertube-/Caption-Endpunkte abrufen
- optionaler, frei konfigurierbarer RapidAPI-Provider mit den Modi:
  - `Aus`
  - `Nur als Fallback`
  - `RapidAPI bevorzugt`
- Briefings direkt über die OpenAI Responses API mit exakt `gpt-5.6-sol` erzeugen
- eigene Briefing-Stile anlegen, auswählen und löschen
- Briefings lokal in `chrome.storage.local` historisieren
- vorhandene Briefings zur gleichen Video-ID erkennen und wahlweise öffnen oder neu erzeugen
- Markdown mit Überschriften, Hervorhebungen, Listen, Blockquotes, Tabellen, Inline-Code, Codeblöcken und sicheren HTTPS-Links rendern
- Briefings einschließlich Titel, Kanal und kanonischer YouTube-URL kopieren

Es gibt keinen LMAA-eigenen Server. Die Extension kommuniziert ausschließlich direkt mit YouTube, OpenAI und – falls aktiviert – einem RapidAPI-Host unter `*.p.rapidapi.com`.

## Installation als entpackte Erweiterung

1. Dieses Repository herunterladen oder klonen.
2. In Chrome `chrome://extensions` öffnen.
3. Den **Entwicklermodus** aktivieren.
4. **Entpackte Erweiterung laden** wählen.
5. Den Ordner auswählen, der `manifest.json` enthält.
6. Über das Extension-Symbol LMAA in einem neuen Tab öffnen.
7. Unter **Verwaltung** den persönlichen OpenAI-Key eintragen und optional RapidAPI konfigurieren.

Nach Änderungen an `manifest.json` oder `network-rules.json` muss die Erweiterung unter `chrome://extensions` über **Neu laden** vollständig neu geladen werden. Anschließend einen bereits geöffneten LMAA-Tab ebenfalls neu öffnen oder aktualisieren.

## Verwendung

1. Einen vollständigen YouTube-Link einfügen.
2. **Analysieren** wählen.
3. Falls bereits ein Briefing für dieselbe Video-ID existiert, entweder das neueste vorhandene Briefing öffnen oder bewusst ein neues erstellen.
4. Das fertige Briefing in der Historie öffnen oder kopieren.

RapidAPI ist für neue Installationen standardmäßig ausgeschaltet. Der direkte YouTube-Pfad benötigt keinen API-Key, verwendet aber eine undokumentierte YouTube-Schnittstelle und kann deshalb durch Änderungen oder Zugriffsbeschränkungen von YouTube ausfallen.

## Konfiguration

### OpenAI

- Modell: fest auf `gpt-5.6-sol`
- API: OpenAI Responses API
- Requests verwenden `store: false` und keine Modell-Tools
- der aktive Stil bestimmt Inhalt, Sprache, Struktur und Ausgabeformat

### RapidAPI

Das mitgelieferte Default-Profil verwendet `youtube-transcripts.p.rapidapi.com`. Endpoint und erlaubte Header können in der Verwaltung angepasst werden. Unterstützte Platzhalter sind:

- `{{canonical_url}}`
- `{{video_id}}`
- `{{language}}`
- `{{rapidapi_key}}` ausschließlich als vollständiger Wert von `X-RapidAPI-Key`

Providerantworten werden nicht an ein providerspezifisches JSON-Schema gebunden. Die geprüfte Rohantwort wird unverändert als klar markierter, unvertrauenswürdiger Datenblock an OpenAI übergeben.

## Berechtigungen

Die Erweiterung fordert nur die für den lokalen Workflow erforderlichen Berechtigungen an:

- `storage`: Einstellungen, Stile und Historie lokal speichern
- YouTube-Hostzugriff: Metadaten, Playerdaten und Captions abrufen
- `api.openai.com`: Briefings erzeugen
- `*.p.rapidapi.com`: optional konfigurierte RapidAPI-Provider aufrufen
- `declarativeNetRequestWithHostAccess`: den von Chrome automatisch gesetzten `Origin`-Header ausschließlich für den intern markierten LMAA-Innertube-Playerrequest entfernen; YouTube beantwortet diesen Request mit Extension-Origin andernfalls mit HTTP 403

Die Netzwerkregel ist in `network-rules.json` eng auf den LMAA-Marker, `www.youtube.com` und den Request-Typ `xmlhttprequest` begrenzt.

## Sicherheit und BYOK

Die Extension enthält keine API-Keys. OpenAI- und RapidAPI-Keys werden vom Nutzer zur Laufzeit eingegeben.

Wichtig: Dieser Browser-Port speichert Einstellungen derzeit in `chrome.storage.local`. Das bietet nicht den Keystore-/Tink-Schutz der Android-App und ist nicht mit serverseitiger Secret-Verwahrung gleichwertig. Die Extension ist deshalb nur für den persönlichen Einsatz mit separaten, möglichst restriktiven Projektkeys, niedrigen Ausgabenlimits und regelmäßigem Verbrauchsmonitoring gedacht.

- niemals Schlüssel in JavaScript, HTML, Manifest, Tests oder Git eintragen
- keine Key-Dateien committen
- bei verdächtigem Verbrauch Keys sofort widerrufen und ersetzen
- vor einer Verteilung an weitere Nutzer die Secret-Architektur neu bewerten

Eingehende URLs, Metadaten, Transkripte, RapidAPI-Antworten und Modell-Markdown gelten als unvertrauenswürdig. Die Extension validiert Video-IDs und Netzwerkziele, führt kein geliefertes HTML aus, begrenzt gerenderte Links auf HTTPS und aktiviert keine Modell-Tools.

## Entwicklung und Tests

Die Kernlogik besitzt keine externen JavaScript-Abhängigkeiten. Mit installiertem Node.js können die synthetischen Contract-Tests ausgeführt werden:

```powershell
node --test lmaa-core.test.cjs
```

Die Tests decken unter anderem folgende Verträge ab:

- RapidAPI-Defaultprofil, Template-Ersetzung und Host-/Keygrenzen
- YouTube-Innertube-Request und Caption-Auswahl
- OpenAI Responses mit exakt `gpt-5.6-sol`, `store: false` und leerer Toolliste
- sicheres Markdown für Tabellen, Blockquotes und HTTPS-Zeitmarkenlinks
- Auswahl des neuesten Briefings bei Duplikaten
- Manifest-Berechtigungen und die eng begrenzte Origin-Regel

`scratch.js` enthält optionale Live-Smokes. Sie können echte Providerkosten oder RapidAPI-Kontingent verbrauchen und sollten nur bewusst mit separaten Testkeys verwendet werden. Die normalen Contract-Tests verwenden ausschließlich synthetische Werte.

## Projektstruktur

| Datei | Zweck |
|---|---|
| `manifest.json` | Manifest V3, Host- und API-Berechtigungen |
| `background.js` | öffnet die Anwendung über das Extension-Symbol |
| `network-rules.json` | eng begrenzte Headerregel für YouTube Innertube |
| `lmaa.html` | Benutzeroberfläche und Styles |
| `lmaa.js` | UI, Speicherung und Analysepipeline |
| `lmaa-core.js` | validierte Provider-, Markdown- und Promptverträge |
| `lmaa-core.test.cjs` | synthetische Contract-Tests |
| `scratch.js` | optionale, kostenbewusste Live-Smokes |

## Verhältnis zum Hauptprojekt

Das Android-Hauptprojekt befindet sich unter [github.com/MartinRJ/LMAA](https://github.com/MartinRJ/LMAA). Es bietet unter anderem die native Android-App mit Room-Historie, WorkManager-Wiederaufnahme und Keystore-/Tink-geschütztem BYOK-Speicher. Die Browserextension ist ein separater Port für den persönlichen Desktop-Workflow und kein Ersatz für diese Android-spezifischen Sicherheits- und Persistenzmechanismen.
