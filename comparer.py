import csv, json, sys, urllib.request
from urllib.parse import urlencode
from datetime import datetime
from statistics import median

PANEL_W = 300  # ton panneau, en watts-crête

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)

# 1. Ville -> coordonnées
city = input("Ville : ").strip()
g = get("https://geocoding-api.open-meteo.com/v1/search?"
        + urlencode({"name": city, "count": 1, "language": "fr"}))
if not g.get("results"):
    sys.exit("Ville introuvable")
p = g["results"][0]
lat, lon = p["latitude"], p["longitude"]
print("Lieu trouvé :", p["name"], p.get("admin1", ""), p.get("country", ""), lat, lon)

# 2. Lecture du fichier Victron
rows = []
with open("SolarHistory.csv", newline="", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        rows.append({
            "date": datetime.strptime(r["Date"], "%m/%d/%y").date(),
            "wh": float(r["Yield(Wh)"]),
            "pleine": float(r["Time in absorption(m)"]) > 0
                      or float(r["Time in float(m)"]) > 0,
        })
rows.sort(key=lambda x: x["date"])
start, end = rows[0]["date"], rows[-1]["date"]

# 3. Rayonnement : historique d'abord, puis modèle récent pour les derniers jours
rad = {}
def charger(url):
    d = get(url)["daily"]
    for t, v in zip(d["time"], d["shortwave_radiation_sum"]):
        if v is not None:
            rad.setdefault(t, v)  # ne remplace pas une valeur déjà là

base = {"latitude": lat, "longitude": lon, "daily": "shortwave_radiation_sum",
        "timezone": "Europe/Paris"}
charger("https://archive-api.open-meteo.com/v1/archive?" + urlencode(
    {**base, "start_date": start.isoformat(), "end_date": end.isoformat()}))
charger("https://api.open-meteo.com/v1/forecast?" + urlencode(
    {**base, "past_days": 60, "forecast_days": 1}))

# 4. Comparaison jour par jour
out, ratios_ok, ratios_all = [], [], []
print(f"\n{'date':<11}{'Wh réels':>9}{'kWh/m²':>8}{'Wh théo':>9}{'ratio':>7}  batterie pleine")
for r in rows:
    mj = rad.get(r["date"].isoformat())
    if mj is None:
        continue
    kwh = mj / 3.6                 # MJ/m² -> kWh/m²
    theo = kwh * PANEL_W           # production théorique sans aucune perte
    ratio = r["wh"] / theo if theo else 0
    ratios_all.append(ratio)
    if not r["pleine"]:
        ratios_ok.append(ratio)
    print(f"{r['date'].isoformat():<11}{r['wh']:>9.0f}{kwh:>8.2f}{theo:>9.0f}{ratio:>7.2f}  {'oui' if r['pleine'] else 'NON'}")
    out.append([r["date"].isoformat(), r["wh"], round(kwh, 2), round(theo), round(ratio, 2), r["pleine"]])

with open("comparaison.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["date", "wh_reels", "kwh_m2", "wh_theorique", "ratio", "batterie_pleine"])
    w.writerows(out)

print("\nJours comparés :", len(ratios_all))
if ratios_ok:
    print(f"Ratio médian, batterie PAS pleine ({len(ratios_ok)} jours) : {median(ratios_ok):.2f}")
print(f"Ratio médian, tous les jours (sous-estimé) : {median(ratios_all):.2f}")