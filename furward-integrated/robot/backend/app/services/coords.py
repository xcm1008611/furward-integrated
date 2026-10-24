import math


def haversine_m(a, b) -> float:
    lng1, lat1, lng2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, max(0, h))))


def wgs84_to_gcj02(lng: float, lat: float) -> tuple[float, float]:
    if not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271):
        return lng, lat
    x, y = lng - 105, lat - 35
    dlat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    dlng = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    common = (20*math.sin(6*x*math.pi) + 20*math.sin(2*x*math.pi)) * 2/3
    dlat += common + (20*math.sin(y*math.pi) + 40*math.sin(y/3*math.pi))*2/3
    dlat += (160*math.sin(y/12*math.pi) + 320*math.sin(y*math.pi/30))*2/3
    dlng += common + (20*math.sin(x*math.pi) + 40*math.sin(x/3*math.pi))*2/3
    dlng += (150*math.sin(x/12*math.pi) + 300*math.sin(x/30*math.pi))*2/3
    rad = math.radians(lat)
    magic = 1 - 0.00669342162296594323 * math.sin(rad)**2
    dlat = dlat*180 / ((6378245*(1-0.00669342162296594323))/(magic**1.5)*math.pi)
    dlng = dlng*180 / (6378245/math.sqrt(magic)*math.cos(rad)*math.pi)
    return lng + dlng, lat + dlat
