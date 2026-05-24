# Amul Ads Intelligence Dashboard — Architecture Reference

## Project Overview
A self-contained single HTML file dashboard for Amul's ad team. Parses Meta Ads Manager Excel exports. No backend, no install, runs in any browser. Built for monthly upload by the ad team — drop in 1-3 monthly Excel files and get instant analysis.

Future Phase 2: Meta Ads API replaces CSV upload. The data layer must be built so only the ingestion function changes — all analysis and UI stays identical.

---

## Tech Stack
- **Single file**: All HTML, CSS, JS in one `.html` file
- **SheetJS (xlsx)**: Excel parsing via CDN
- **Chart.js**: All charts via CDN
- **Fonts**: Syne (headings) + IBM Plex Sans (body) via Google Fonts
- **No frameworks**: Vanilla JS only

---

## File Upload & Date Detection

### Rules
- Accept 1-3 Excel files maximum. Block 4+.
- For each file, detect the reporting period:
  1. First try: read `Reporting starts` and `Reporting ends` columns (case-insensitive, trimmed)
  2. Fallback: parse filename for month/year pattern (e.g. `March-2026`, `Feb_26`, `Mar'26`)
- Label each dataset as `MMM YYYY` (e.g. `Mar 2026`)
- Most recently dated file = **current month**
- Earlier files = **historical months**
- If only 1 file: no MoM shown anywhere

---

## Data Processing Pipeline

On every file upload, run in this exact order:

### Step 1 — Parse rows
For each row extract:
```
name          → Campaign name column
metaPlatform  → Platform column (raw Meta value)
objective     → Objective column
impressions   → Impressions
clicks        → Link clicks
spend         → Amount spent (INR)
reach         → Reach
engagements   → Post engagements
budget        → Campaign Budget (fallback to spend if 0)
v3s           → 3-second video plays
v25           → Video plays at 25%
v50           → Video plays at 50%
v75           → Video plays at 75%
v95           → Video plays at 95%
v100          → Video plays at 100%
```

### Step 2 — Parse campaign name
```
platform:
  1. If name contains _FB_ → Facebook
  2. Else if name contains _IG_ → Instagram
  3. Else if metaPlatform === Facebook → Facebook
  4. Else if metaPlatform === Instagram → Instagram
  5. Else → Combined/Auto

type:
  1. Structural: split name by _, take position[1], validate (not a date/number/city)
  2. Keyword fallback: _TOPICAL_→Topical, _LIVE_→Live Video, _IPL_→IPL, _SCOOPING_→Scooping, _BRAND_→Brand
  3. Else → Untagged

format:
  1. Structural: split name by _, take position[3], validate
  2. Keyword fallback: _REEL_→Reel, _VIDEO_→Video, _CAROUSEL_→Carousel, _STATIC_→Static, _POST_→Post
  3. Live Video type → always Video format
  4. Else → Untagged

date:
  1. Regex match patterns: 29th Mar'26, 6th March'26, 28th Feb'26 etc.
  2. Else → null (date unknown)
```

### Step 3 — Calculate per-campaign metrics
```
budgetUtil  = spend / budget × 100
ctr         = clicks / impressions × 100   ← calculated for ALL campaigns always
cpm         = spend / impressions × 1000
cpc         = spend / clicks
cpe         = spend / engagements
engRate     = engagements / reach × 100
cpr         = spend / reach
hasVideo    = v3s > 0
```

**IMPORTANT — CTR is calculated for all objectives internally.**
CTR is only DISPLAYED for Traffic campaigns in regular views.
Creative Opportunity section uses CTR for all objectives to detect cross-objective signals.
This is intentional. Do not filter CTR calculation by objective.

### Step 4 — Classify active vs inactive
```
inactive = budgetUtil < BENCHMARKS.inactiveThreshold (default 5%)
active   = budgetUtil >= BENCHMARKS.inactiveThreshold
```

**All calculations across all tabs use active campaigns only unless explicitly stated.**
Inactive campaigns only appear in the Inactive Ads tab.
Budget Utilisation metric is the one exception — calculated on all campaigns.

### Step 5 — Flag untagged campaigns
If any campaign has type = Untagged OR format = Untagged:
- Show warning banner below nav
- "X campaigns could not be auto-tagged — [View untagged →]"
- Link filters Drill-down to show only Untagged

### Step 6 — Calculate Creative Opportunity signals (post-processing)
Run after all metrics are calculated on active campaigns:

**Signal 1 — Engagement ads with CTR above CTR benchmark:**
- Filter: objective === Engagement
- Flag: ctr > BENCHMARKS.ctr
- Label: "Engagement ad driving unexpected clicks"

**Signal 2 — Traffic ads with high Engagement Rate:**
- Filter: objective === Traffic
- Flag: engRate > BENCHMARKS.engagementRate
- Label: "Traffic ad resonating beyond its objective"

**Signal 3 — Awareness ads with low CPM and high Reach Efficiency:**
- Filter: objective === Awareness
- Flag: cpm < BENCHMARKS.cpm AND (reach/spend) > avgReachEfficiency
- avgReachEfficiency = sum(reach) / sum(spend) across all active Awareness campaigns
- If no Awareness campaigns → store empty state note: "No Awareness campaigns this month"
- Label: "Awareness ad delivering exceptional reach per rupee"

**Signal 4 — Ads appearing in Top 5 across 2+ metrics:**
- Build Top 5 by: CTR (Traffic), Reach (all), Engagement Rate (Engagement), CPM efficiency (all, lower=better)
- Count appearances per campaign
- Flag: appearances >= 2
- Label: "Multi-dimensional performer"

Store all signals as an array: `creativeOpportunity[]`

---

## Benchmarks

All benchmarks are user-editable in the Benchmarks & Formulas tab.
Stored in a global `BENCHMARKS` object. Any change immediately recalculates the dashboard.

```javascript
const BENCHMARKS = {
  ctr: 1,                    // % — Traffic benchmark
  trafficPoorCTR: 0.5,       // % — Traffic poor performing threshold
  engagementPoorRate: 1,     // % — Engagement poor performing threshold
  awarenesspoorCPM: 25,      // ₹ — Awareness poor performing threshold
  inactiveThreshold: 5,      // % — Budget utilisation below this = inactive
  poorBudgetMin: 5,          // % — Poor budget utilisation range min
  poorBudgetMax: 50,         // % — Poor budget utilisation range max
  cpm: 20,                   // ₹ — Industry CPM benchmark (TBC with Amul)
  cpc: 5,                    // ₹ — Industry CPC benchmark (TBC with Amul)
  cpe: 2,                    // ₹ — Industry CPE benchmark (TBC with Amul)
  engagementRate: 1,         // % — Industry engagement rate benchmark
  cpr: 0.5,                  // ₹ — Industry CPR benchmark (TBC with Amul)
  videoCompletion: 25,       // % — Industry video completion rate benchmark
}
```

---

## Objective-Based Primary Metrics

Every place an ad is displayed — lists, popups, cards, tables — the metrics shown depend on the campaign's objective:

| Objective | Primary Metric | Secondary Metric |
|-----------|---------------|-----------------|
| Traffic | CTR | CPC |
| Engagement | Engagement Rate | CPE |
| Awareness | Reach | CPR |

Mixed-objective lists show different metric pairs per row. This is correct behaviour.

---

## MoM (Month-over-Month) Rules

- Change column always compares most recent month vs previous month
- If only 1 file uploaded → no MoM shown anywhere
- Delta format: `[MetricName] ↑ [AbsoluteValue] (+[%])`
  - e.g. `Spend ↑ ₹2.9L (+6%)`
- Color coding (metric-aware):
  - Lower CPM = better = teal
  - Higher Reach = better = teal
  - Lower CPE = better = teal
  - Higher CTR = better = teal
  - Higher Spend = neutral = gold
  - Lower Budget Utilisation = amber

---

## Color System

```
Background:        #070B14
Card background:   #0D1526
Border:            #18253F
Primary red:       #A8001A   (Amul brand, negative signals)
Gold:              #F5A623   (neutral metrics — spend, reach, impressions, count)
Teal:              #00C9A7   (positive signals, above benchmark, good MoM)
Amber:             #B8860B   (caution, below benchmark, warning)
Blue (Facebook):   #1877F2
Pink (Instagram):  #E1306C
Teal (Combined):   #00C9A7
Primary text:      #EEF2FF
Secondary text:    #8A9CC0
Dimmed text:       #6B7FA3
NEVER use below:   #6B7FA3   for any visible text
```

---

## Typography

```
Fonts: Syne (headings/values), IBM Plex Sans (body/labels)

Page title:        22px Syne Bold
Tab labels:        14px IBM Plex Sans Medium
Card labels:       12px uppercase IBM Plex Sans SemiBold #8A9CC0
Primary values:    28px Syne ExtraBold
Secondary values:  16px IBM Plex Sans Medium
Body text:         15px IBM Plex Sans Regular
Small/note text:   13px IBM Plex Sans Regular #8A9CC0
Table headers:     13px uppercase IBM Plex Sans SemiBold
Table cells:       14px IBM Plex Sans Regular
```

KPI card font size cap:
- Value > 6 chars → 20px
- Value > 8 chars → 18px

---

## Global UI Components

### Cards
- Background: #0D1526, border: 1px solid #18253F, radius: 14px, padding: 22px
- All cards clickable → open popup
- Hover: border brightens to #2E3F60, cursor: pointer

### Popups / Modals
- Background: #0D1526, border: 1px solid #18253F, radius: 16px
- Close on outside click or X button
- Max width: 720px, scrollable if overflow

### Side Panel (Ad Stats)
- Slides in from right
- Shows full stats for a single ad
- Sections: Overview metrics, Video retention (if applicable), Budget utilisation bar, MoM if historical data exists
- Does not close the parent popup/page — user keeps context

### Charts (Chart.js)
- Background: transparent
- Grid lines: #18253F
- Axis labels: #8A9CC0, 13px
- Tooltip: background #0D1526, border #18253F
- Hover always shows exact values
- Campaign/ad count shown below X axis labels on ALL bar charts

### Tables
- Header: 13px uppercase #8A9CC0
- Row border: 1px solid #0B1423
- Hover row: #111E38
- All numeric columns sortable ↑↓
- All campaign name cells have copy icon — click copies full name, toast "Copied to clipboard" 2 seconds

### Top 5 / Bottom 5 Lists
- Collapsible, collapsed by default
- Label: ▶ Top 5 by [Metric] / ▶ Bottom 5 by [Metric]
- Each row: objective-based primary metric + CPM + copy button
- Each row clickable → ad stats side panel

### Empty States
- Every section that could be empty shows a note
- Format: italic, #6B7FA3, 13px
- Examples: "No Awareness campaigns this month" / "No data available"

### Footer Footnotes
- Bottom of every tab
- Only rules relevant to that tab
- Font: #6B7FA3, 13px

### Untagged Warning Banner
- Shows below nav when untagged campaigns exist
- Amber background
- "X campaigns could not be auto-tagged — [View untagged →]"

### Toast Notifications
- Bottom right corner
- 2 second duration
- "Copied to clipboard"

---

## Tab Structure (in order)

1. Overview
2. Platforms
3. Pages
4. Formats
5. Campaigns
6. Drill-down
7. Inactive Ads
8. Benchmarks & Formulas

SKU tab: code exists but hidden (display:none)

---

## Overview Tab — Layout

### F-rule layout (left→right, top→bottom priority):
Row 1 — Four stat cards (left to right: Spend → Campaigns → Reach → Impressions)
Row 2 — Creative Opportunity section
Row 3 — Ad Calendar

### Card specs:

**Card 1 — Total Spend (popup on click)**
Card shows: Total spend | Budget utilisation % | MoM % change for both
Popup:
- Section 1: Platform bar chart (Y: spend, X: platforms, count below labels, hover: exact spend + combined budget util)
- Section 2: Spend by Objective bar chart (Y: spend, X: objectives, count below labels)
- Section 3: MoM table — rows: Spend, Budget Utilisation | cols: [months] + Change
- Section 4: Top 5 ads by Budget Utilisation (collapsible) — objective-based metrics + copy + clickable
- Section 5: Bottom 5 ads by Budget Utilisation (collapsible) — same

**Card 2 — Campaigns (popup on click)**
Card shows: Active campaign count | MoM % change | Inactive count + spend wasted (smaller text)
Popup:
- Section 1: Stacked bar chart — Y: number of ads, X: campaign type (dynamic), stacked by objective, hover: exact count per objective
- Section 2: Horizontal stacked bar chart — Y: campaign type, X: spend, stacked by objective, hover: exact spend per objective
- Section 3: MoM table — rows: No. of campaigns run | cols: [months] + Change

**Card 3 — Total Reach (popup on click)**
Card shows: Total reach | MoM % change
Popup:
- Section 1: Platform bar chart (Y: reach, X: platforms, count below labels)
- Section 2: MoM table — rows: Reach | cols: [months] + Change
- Section 3: Top 5 ads highest reach (collapsible) — Ad name, Objective, Platform, objective metric, Spend, Budget util
- Section 4: Bottom 5 ads least reach (collapsible) — same
- Note: "Includes ads from all objectives"

**Card 4 — Total Impressions (popup on click)**
Card shows: Total impressions | MoM % change
Popup: Same structure as Reach card, replace Reach with Impressions throughout

### Creative Opportunity Section
Four signals (see data processing section above).
Each entry: Ad name (copyable, clickable) | Signal label | Two relevant metrics
If a signal has no qualifying ads → show: "No [signal description] detected this month"
If objective type doesn't exist in data → show: "No [objective] campaigns this month"

### Ad Calendar
- Current month only
- Calendar grid showing all days of the month
- Days with campaigns: show dot + count of campaigns posted
- Date detection: regex from campaign name. Campaigns with no detectable date → listed in corner note: "X ads — posting date could not be determined"
- Click a date → popup showing ads posted that day:
  - Traffic → Impressions + CTR + CPC
  - Engagement → CPE + Engagement Rate + Impressions
  - Awareness → Reach + CPR + Impressions
- Each ad in popup: clickable → side panel
- Disclaimer at bottom: "Dates shown are posting dates only, not actual campaign run duration"

---

## Benchmarks & Formulas Tab

### Section 1 — Benchmarks (editable)
Each benchmark has: label, input field, unit, description
On change: immediately recalculate all signals and re-render affected components

### Section 2 — Formulas Reference Table

| Metric | Formula | Scope | Display Rule |
|--------|---------|-------|-------------|
| CTR (per campaign) | Link Clicks / Impressions × 100 | Calculated: all | Displayed: Traffic only (except Creative Opportunity) |
| CTR (blended) | Sum(Link Clicks) / Sum(Impressions) × 100 | Traffic only | With note |
| CPM | Amount Spent / Impressions × 1000 | All active | All objectives |
| CPC | Amount Spent / Link Clicks | All active | Traffic only |
| CPE | Amount Spent / Post Engagements | All active | Engagement + Awareness |
| CPE (blended) | Sum(Spend) / Sum(Engagements) | All active | — |
| Engagement Rate | Post Engagements / Reach × 100 | All active | Engagement primarily |
| Budget Utilisation | Amount Spent / Campaign Budget × 100 | ALL campaigns including inactive | — |
| CPR | Amount Spent / Reach | All active | Awareness primarily |
| Reach Efficiency | Reach / Amount Spent | All active | People per ₹1 |
| Video Retention | Views at milestone / 3-sec plays × 100 | Video campaigns only | — |

Note at top: "All blended metrics sum numerator and denominator separately before dividing — not an average of individual rates. Inactive campaigns (budget utilisation < threshold) are excluded from all metrics except Budget Utilisation."

---

## Inactive Ads Tab

### Section 1 — Inactive Ads
Definition: budgetUtil < BENCHMARKS.inactiveThreshold
Sorted by budget utilisation ascending (worst first)
Columns: Campaign Name (copyable), Objective, Platform, Type, Format, Spend, Budget, Utilisation %
Note: "These campaigns are excluded from all calculations across the dashboard"

### Section 2 — Poor Performing Ads
budgetUtil >= inactiveThreshold but underperforming:
- Traffic: CTR < BENCHMARKS.trafficPoorCTR
- Engagement: engRate < BENCHMARKS.engagementPoorRate
- Awareness: cpm > BENCHMARKS.awarenesspoorCPM

Columns: Campaign Name (copyable), Objective, Platform, Type, primary metric, Spend, CPM
Sorted by primary metric ascending

Footer: "Inactive: Budget utilisation < [threshold]% · Poor performing: Traffic CTR < [x]% | Engagement Rate < [x]% | Awareness CPM > ₹[x]"

---

## Phase 2 — Meta API Migration Notes

When Meta API is connected, only the data ingestion layer changes.
Replace the file upload + SheetJS parsing with API calls to:
- `/act_{ad_account_id}/insights` with breakdowns by campaign, platform, placement
- Fields: spend, impressions, reach, clicks, engagements, cpm, ctr, cpc

The `processRows()` function signature stays identical — it receives an array of campaign objects with the same field names. The API adapter maps Meta's field names to the same internal field names used by processRows().

Everything downstream — metrics, benchmarks, signals, UI — requires zero changes.
