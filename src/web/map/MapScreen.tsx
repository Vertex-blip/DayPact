import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap, Marker } from 'maplibre-gl';
import {
  Bookmark,
  Check,
  Download,
  Info,
  LoaderCircle,
  MapPin,
  Navigation,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { Locale, Plan, Place, Theme } from '../../shared/contracts';
import { dateLabel, texts } from '../i18n';
import {
  cancelMapDownload,
  ensureMapPackage,
  formatMB,
  readMapResource,
  useMapPackage,
} from './offlinePackage';
import { offlineStyle } from './style';
import {
  activateSavedPlaceSession,
  deleteSavedPlace,
  listSavedPlaces,
  savePlace,
  type SavedPlace,
} from './savedPlaces';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';

export interface MapScreenProps {
  plans: Plan[];
  locale: Locale;
  theme?: Theme;
  initialTab?: 'plans' | 'saved';
  onSelectPlan: (plan: Plan) => void;
  onPickPlace?: (place: Place) => void;
  onAddPlan?: () => void;
  onCancelPick?: () => void;
  userId?: string;
}
interface IndexedPlace extends Place {
  kk?: string | null;
  ru?: string | null;
  kind?: string;
}
const copy = {
  kk: {
    search: 'Орын немесе жоспар іздеу',
    plans: 'Ортақ жоспарлар',
    saved: 'Сақталғандар',
    layers: 'Карта туралы',
    dark: 'Қараңғы',
    light: 'Ашық',
    location: 'Менің орным',
    cancel: 'Болдырмау',
    loading: 'Астана картасы жүктелуде',
    checking: 'Картаны дайындап жатырмыз',
    retry: 'Қайта жүктеу',
    download: 'Картаны жүктеу',
    ready: 'Астана · офлайн',
    error: 'Картаны жүктеу мүмкін болмады',
    offline: 'Интернет жоқ. Картаны алдын ала жүктеп алу керек.',
    quota: 'Құрылғыда бос орын жеткіліксіз. Орын босатып, қайта көріңіз.',
    integrity: 'Жүктелген файл толық емес. Қайта жүктеп көріңіз.',
    unsupported: 'Бұл браузер офлайн карта сақтауды қолдамайды. Жаңартылған браузерді қолданыңыз.',
    open: 'Жоспарды ашу',
    save: 'Сақтау',
    remove: 'Өшіру',
    select: 'Осы орынды таңдау',
    point: 'Картадағы орын',
    pick: 'Жоспарға орын қосу үшін картаны түртіңіз',
    searchHint: 'Жүктелген Астана картасы мен жоспарлардан іздеу',
    noResults: 'Сәйкес орын табылмады',
    noSaved: 'Сақталған орындар әзірге жоқ. Картаны түртіп, орынды сақтаңыз.',
    local: 'Сақталған орындар осы құрылғыда қалады',
    savedError: 'Орынды сақтау мүмкін болмады. 100 орынға дейін сақтауға болады.',
    geoDenied: 'Геолокацияға рұқсат берілмеді. Браузер баптауларын тексеріңіз.',
    geoError: 'Орныңызды анықтау мүмкін болмады. Қайта көріңіз.',
    geoOutside: 'Бұл пакет тек Астана аумағын қамтиды. Орныңыз оның сыртында.',
    accuracy: 'Дәлдігі',
    meters: 'м',
    height: 'Биіктігі белгісіз ғимараттар шартты 6 м биіктікте көрсетіледі.',
    noPlans: 'Осы күнге орны көрсетілген жоспар жоқ.',
    close: 'Жабу',
    data: 'Карта деректері',
    render: 'Карта ашылмады. Қайта көріңіз. Браузер WebGL қолдауы керек.',
  },
  ru: {
    search: 'Найти место или план',
    plans: 'Общие планы',
    saved: 'Сохранённые',
    layers: 'О карте',
    dark: 'Тёмная',
    light: 'Светлая',
    location: 'Моё местоположение',
    cancel: 'Отмена',
    loading: 'Загрузка карты Астаны',
    checking: 'Подготавливаем карту',
    retry: 'Повторить загрузку',
    download: 'Скачать карту',
    ready: 'Астана · офлайн',
    error: 'Не удалось загрузить карту',
    offline: 'Нет интернета. Для работы офлайн сначала скачайте карту.',
    quota: 'На устройстве недостаточно места. Освободите место и повторите.',
    integrity: 'Файл загрузился не полностью. Попробуйте ещё раз.',
    unsupported: 'Браузер не поддерживает хранение офлайн-карт. Используйте обновлённый браузер.',
    open: 'Открыть план',
    save: 'Сохранить',
    remove: 'Удалить',
    select: 'Выбрать это место',
    point: 'Точка на карте',
    pick: 'Нажмите на карту, чтобы добавить место в план',
    searchHint: 'Поиск по загруженной карте Астаны и вашим планам',
    noResults: 'Подходящее место не найдено',
    noSaved: 'Сохранённых мест пока нет. Нажмите на карту, чтобы сохранить место.',
    local: 'Сохранённые места остаются на этом устройстве',
    savedError: 'Не удалось сохранить место. Можно сохранить до 100 мест.',
    geoDenied: 'Нет доступа к геолокации. Проверьте настройки браузера.',
    geoError: 'Не удалось определить местоположение. Попробуйте ещё раз.',
    geoOutside: 'Этот пакет содержит только Астану. Вы находитесь за его пределами.',
    accuracy: 'Точность',
    meters: 'м',
    height: 'Для зданий без высоты используется условная высота 6 м.',
    noPlans: 'На этот день нет планов с местом на карте.',
    close: 'Закрыть',
    data: 'Данные карты',
    render: 'Не удалось открыть карту. Попробуйте ещё раз. Браузер должен поддерживать WebGL.',
  },
};
function pointInBounds(place: Place, bounds: [number, number, number, number]) {
  return (
    place.lng >= bounds[0] &&
    place.lng <= bounds[2] &&
    place.lat >= bounds[1] &&
    place.lat <= bounds[3]
  );
}
const placeLabel = (p: IndexedPlace, locale: Locale) => p[locale] || p.label;
const planDate = (date: string, locale: Locale) =>
  dateLabel(date, locale, { day: 'numeric', month: 'long' });

export function MapScreen({
  plans,
  locale,
  theme = 'system',
  initialTab = 'plans',
  onSelectPlan,
  onPickPlace,
  onAddPlan,
  onCancelPick,
  userId,
}: MapScreenProps) {
  const t = copy[locale],
    pkg = useMapPackage();
  const container = useRef<HTMLDivElement>(null),
    map = useRef<LibreMap | null>(null);
  const markers = useRef<Marker[]>([]),
    pointMarker = useRef<Marker | null>(null),
    locationMarker = useRef<Marker | null>(null);
  const generation = useRef(0),
    locating = useRef<number | undefined>(undefined),
    geoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mapReady, setMapReady] = useState(false),
    [renderError, setRenderError] = useState(false);
  const [query, setQuery] = useState(''),
    [searching, setSearching] = useState(false),
    [index, setIndex] = useState<IndexedPlace[]>([]);
  const [saved, setSaved] = useState<SavedPlace[]>([]),
    [tab, setTab] = useState<'plans' | 'saved'>(initialTab);
  const [plan, setPlan] = useState<Plan | null>(null),
    [point, setPoint] = useState<Place | null>(null);
  const [label, setLabel] = useState(''),
    [threeD, setThreeD] = useState(false),
    [layerMenu, setLayerMenu] = useState(false);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const light = theme === 'light' || (theme === 'system' && !systemDark);
  const [message, setMessage] = useState<string | null>(null),
    [geoBusy, setGeoBusy] = useState(false),
    [accuracy, setAccuracy] = useState<number | null>(null);
  const selection = useRef({ locale, onPickPlace });
  selection.current = { locale, onPickPlace };
  const activeUser = useRef(userId);
  activeUser.current = userId;

  useEffect(() => {
    void ensureMapPackage().catch(() => {});
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let alive = true;
    setSaved([]);
    setPoint(null);
    setPlan(null);
    if (userId) {
      activateSavedPlaceSession(userId);
      void listSavedPlaces(userId)
        .then((value) => {
          if (alive) setSaved(value);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [userId]);
  useEffect(() => {
    if (pkg.status !== 'ready') return;
    let alive = true;
    void readMapResource('/map-assets/places.json')
      .then((r) => r.json())
      .then((places) => {
        if (alive && Array.isArray(places)) setIndex(places as IndexedPlace[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pkg.status, pkg.manifest?.id]);

  useEffect(() => {
    if (pkg.status !== 'ready' || !pkg.manifest || !container.current) return;
    let alive = true;
    const host = container.current;
    setRenderError(false);
    void offlineStyle(pkg.manifest, locale, light, threeD)
      .then((style) => {
        if (!alive) return;
        const m = new maplibregl.Map({
          container: host,
          style,
          center: pkg.manifest!.center,
          zoom: 15.0,
          pitch: threeD ? 32 : 0,
          bearing: 0,
          minZoom: 10,
          maxZoom: 19,
          maxBounds: [
            [pkg.manifest!.bounds[0], pkg.manifest!.bounds[1]],
            [pkg.manifest!.bounds[2], pkg.manifest!.bounds[3]],
          ],
          attributionControl: false,
          renderWorldCopies: false,
          maxTileCacheSize: 80,
          canvasContextAttributes: { antialias: false },
        });
        map.current = m;
        m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
        m.on('load', () => {
          if (alive) setMapReady(true);
        });
        m.on('error', (event) => {
          if (
            alive &&
            /WebGL|context|style|Worker failed|offline|integrity/i.test(event.error?.message ?? '')
          )
            setRenderError(true);
        });
        m.on('click', (event) => {
          const features = m
            .queryRenderedFeatures(event.point)
            .filter((f) => f.sourceLayer === 'pois' || f.sourceLayer === 'places');
          const properties = features[0]?.properties;
          const name = properties?.[`name:${selection.current.locale}`] ?? properties?.name;
          const next = {
            lng: event.lngLat.lng,
            lat: event.lngLat.lat,
            label:
              typeof name === 'string' ? name.slice(0, 120) : copy[selection.current.locale].point,
          };
          setPoint(next);
          setLabel(next.label);
          setPlan(null);
          setSearching(false);
          setMessage(null);
        });
        const resize = new ResizeObserver(() => m.resize());
        resize.observe(host);
        m.on('remove', () => resize.disconnect());
      })
      .catch(() => {
        if (alive) setRenderError(true);
      });
    return () => {
      alive = false;
      setMapReady(false);
      map.current?.remove();
      map.current = null;
    };
    // Locale/layer changes use setStyle below and retain camera position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg.status === 'ready', pkg.manifest?.id]);

  useEffect(() => {
    if (!mapReady || !map.current || !pkg.manifest) return;
    const m = map.current;
    let alive = true;
    void offlineStyle(pkg.manifest, locale, light, threeD)
      .then((style) => {
        if (alive && map.current === m) m.setStyle(style);
      })
      .catch(() => {
        if (alive) setRenderError(true);
      });
    m.easeTo({ pitch: threeD ? 32 : 0, duration: 500 });
    return () => {
      alive = false;
    };
  }, [locale, light, threeD, mapReady, pkg.manifest]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];
    const entries =
      tab === 'plans'
        ? plans.filter((p) => p.place).map((p) => ({ place: p.place!, plan: p }))
        : saved.map((place) => ({ place, plan: null }));
    for (const entry of entries) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `dp-map-pin${entry.plan ? '' : ' dp-map-pin-saved'}`;
      el.textContent = entry.plan
        ? `${entry.plan.time} ${entry.plan.title.slice(0, 22)}`
        : entry.place.label.slice(0, 25);
      el.setAttribute('aria-label', entry.plan?.title ?? entry.place.label);
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        setSearching(false);
        setMessage(null);
        if (entry.plan) {
          setPlan(entry.plan);
          setPoint(null);
        } else {
          setPoint(entry.place);
          setLabel(entry.place.label);
          setPlan(null);
        }
        m.easeTo({ center: [entry.place.lng, entry.place.lat], duration: 450 });
      });
      markers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([entry.place.lng, entry.place.lat])
          .addTo(m),
      );
    }
    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
    };
  }, [plans, saved, tab, mapReady]);

  useEffect(() => {
    pointMarker.current?.remove();
    pointMarker.current = null;
    if (point && map.current && mapReady) {
      pointMarker.current = new maplibregl.Marker({ color: '#7fa9ff' })
        .setLngLat([point.lng, point.lat])
        .addTo(map.current);
      map.current.easeTo({ center: [point.lng, point.lat], duration: 450 });
    }
    return () => {
      pointMarker.current?.remove();
      pointMarker.current = null;
    };
  }, [point, mapReady]);

  const stopLocation = () => {
    generation.current++;
    if (locating.current !== undefined) navigator.geolocation?.clearWatch(locating.current);
    if (geoTimer.current) clearTimeout(geoTimer.current);
    locating.current = undefined;
    geoTimer.current = undefined;
    setGeoBusy(false);
  };
  useEffect(
    () => () => {
      generation.current++;
      if (locating.current !== undefined) navigator.geolocation?.clearWatch(locating.current);
      if (geoTimer.current) clearTimeout(geoTimer.current);
    },
    [],
  );
  function locate() {
    if (geoBusy) {
      stopLocation();
      return;
    }
    if (!navigator.geolocation) {
      setMessage(t.geoError);
      return;
    }
    setMessage(null);
    setGeoBusy(true);
    const request = ++generation.current;
    const finish = () => {
      if (locating.current !== undefined) navigator.geolocation.clearWatch(locating.current);
      locating.current = undefined;
      if (geoTimer.current) clearTimeout(geoTimer.current);
      setGeoBusy(false);
    };
    locating.current = navigator.geolocation.watchPosition(
      (position) => {
        if (request !== generation.current) return;
        finish();
        const p = {
          lng: position.coords.longitude,
          lat: position.coords.latitude,
          label: t.location,
        };
        if (pkg.manifest && !pointInBounds(p, pkg.manifest.bounds)) {
          setMessage(t.geoOutside);
          return;
        }
        setAccuracy(Math.round(position.coords.accuracy));
        const m = map.current;
        if (!m) return;
        locationMarker.current?.remove();
        const el = document.createElement('div');
        el.className = 'dp-user-location';
        el.setAttribute('aria-label', t.location);
        locationMarker.current = new maplibregl.Marker({ element: el })
          .setLngLat([p.lng, p.lat])
          .addTo(m);
        m.easeTo({ center: [p.lng, p.lat], zoom: 16, duration: 650 });
      },
      (error) => {
        if (request !== generation.current) return;
        finish();
        setMessage(error.code === 1 ? t.geoDenied : t.geoError);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
    geoTimer.current = setTimeout(() => {
      if (request === generation.current) {
        stopLocation();
        setMessage(t.geoError);
      }
    }, 15000);
  }

  const normalized = query.trim().toLocaleLowerCase(locale);
  const planResults = normalized
    ? plans
        .filter(
          (p) =>
            `${p.title} ${p.place?.label ?? ''}`.toLocaleLowerCase(locale).includes(normalized) &&
            p.place,
        )
        .slice(0, 5)
    : [];
  const searchCenter = map.current?.getCenter() ?? { lat: 51.1282, lng: 71.4304 };
  const distance = (p: Place) =>
    Math.hypot(
      (p.lng - searchCenter.lng) * Math.cos((searchCenter.lat * Math.PI) / 180),
      p.lat - searchCenter.lat,
    );
  const placeResults =
    normalized.length >= 2
      ? index
          .filter((p) =>
            `${p.label} ${p.kk ?? ''} ${p.ru ?? ''}`.toLocaleLowerCase(locale).includes(normalized),
          )
          .sort((a, b) => distance(a) - distance(b))
          .slice(0, 12)
      : [];
  const selectPoint = (p: IndexedPlace) => {
    const next = { lat: p.lat, lng: p.lng, label: placeLabel(p, locale) };
    setPoint(next);
    setLabel(next.label);
    setPlan(null);
    setSearching(false);
    setQuery('');
  };
  const alreadySaved = point
    ? saved.find(
        (p) => Math.abs(p.lat - point.lat) < 0.00001 && Math.abs(p.lng - point.lng) < 0.00001,
      )
    : undefined;
  async function toggleSaved() {
    if (!userId || !point) return;
    try {
      if (alreadySaved) await deleteSavedPlace(userId, alreadySaved.id);
      else await savePlace(userId, { ...point, label });
      const updated = await listSavedPlaces(userId);
      if (activeUser.current === userId) {
        setSaved(updated);
        setMessage(null);
      }
    } catch {
      if (activeUser.current === userId) setMessage(t.savedError);
    }
  }
  const closeSelection = () => {
    setPoint(null);
    setPlan(null);
  };
  const packageMessage =
    pkg.error === 'quota'
      ? t.quota
      : pkg.error === 'offline'
        ? t.offline
        : pkg.error === 'integrity'
          ? t.integrity
          : pkg.error === 'unsupported'
            ? t.unsupported
            : t.error;

  return (
    <section
      className="dp-map-screen"
      data-map-theme={light ? 'light' : 'dark'}
      aria-label={locale === 'kk' ? 'Астана картасы' : 'Карта Астаны'}
    >
      <div className="dp-map-viewport">
        <div ref={container} className="dp-map-canvas" />
        {(pkg.status !== 'ready' || renderError) && (
          <div className="dp-map-loading" role="status">
            <div className="dp-map-loading-icon">
              <MapPin size={28} />
            </div>
            <h2>
              {renderError
                ? t.render
                : pkg.status === 'downloading'
                  ? t.loading
                  : pkg.status === 'checking'
                    ? t.checking
                    : pkg.status === 'error'
                      ? packageMessage
                      : t.download}
            </h2>
            {pkg.status === 'downloading' && (
              <>
                <progress aria-label={t.loading} value={pkg.loaded} max={pkg.total || 1} />
                <p>
                  {formatMB(pkg.loaded)} / {formatMB(pkg.total)}
                </p>
              </>
            )}
            {pkg.status === 'checking' && <LoaderCircle className="dp-spin" aria-hidden="true" />}
            {pkg.status === 'downloading' || pkg.status === 'checking' ? (
              <button className="dp-map-text-button" onClick={cancelMapDownload}>
                {t.cancel}
              </button>
            ) : (
              <button
                className="dp-map-primary"
                onClick={() => void ensureMapPackage().catch(() => {})}
              >
                <Download size={18} />
                {pkg.status === 'error' || renderError ? t.retry : t.download}
                {pkg.total > 0 ? ` · ${formatMB(pkg.total)}` : ''}
              </button>
            )}
          </div>
        )}
        {pkg.status === 'ready' && !renderError && (
          <>
            <div className="dp-map-top">
              <div className="dp-map-search">
                <Search size={21} />
                <input
                  aria-label={t.search}
                  placeholder={t.search}
                  value={query}
                  maxLength={100}
                  onFocus={() => setSearching(true)}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSearching(true);
                  }}
                />
                {searching && (
                  <button
                    type="button"
                    aria-label={t.close}
                    onClick={() => {
                      setSearching(false);
                      setQuery('');
                    }}
                  >
                    <X size={19} />
                  </button>
                )}
                {onCancelPick ? (
                  <button
                    type="button"
                    className="dp-map-create"
                    aria-label={texts(locale).cancel}
                    onClick={() => {
                      setPoint(null);
                      setPlan(null);
                      setSearching(false);
                      onCancelPick();
                    }}
                  >
                    <X size={22} />
                  </button>
                ) : (
                  onAddPlan && (
                    <button
                      type="button"
                      className="dp-map-create"
                      aria-label={texts(locale).newPlan}
                      onClick={() => {
                        setPoint(null);
                        setPlan(null);
                        setSearching(false);
                        onAddPlan();
                      }}
                    >
                      <Plus size={24} />
                    </button>
                  )
                )}
              </div>
              {searching ? (
                <div className="dp-map-results">
                  <p>{t.searchHint}</p>
                  {planResults.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setPlan(p);
                        setPoint(null);
                        setSearching(false);
                        setQuery('');
                        map.current?.easeTo({
                          center: [p.place!.lng, p.place!.lat],
                          duration: 450,
                        });
                      }}
                    >
                      <Users size={18} />
                      <span>
                        {p.title}
                        <small>{p.place!.label}</small>
                      </span>
                    </button>
                  ))}
                  {placeResults.map((p, i) => (
                    <button key={`${p.lng}-${p.lat}-${i}`} onClick={() => selectPoint(p)}>
                      <MapPin size={18} />
                      <span>{placeLabel(p, locale)}</span>
                    </button>
                  ))}
                  {normalized.length >= 2 &&
                    planResults.length === 0 &&
                    placeResults.length === 0 && <p>{t.noResults}</p>}
                </div>
              ) : (
                <div className="dp-map-tabs">
                  <button
                    className={tab === 'plans' ? 'active' : ''}
                    onClick={() => {
                      setTab('plans');
                      setPoint(null);
                    }}
                  >
                    <Users size={17} />
                    {t.plans}
                  </button>
                  <button
                    className={tab === 'saved' ? 'active' : ''}
                    onClick={() => {
                      setTab('saved');
                      setPlan(null);
                    }}
                  >
                    <Bookmark size={17} />
                    {t.saved}
                  </button>
                </div>
              )}
              {onPickPlace && !point && !searching && <div className="dp-map-hint">{t.pick}</div>}
              {tab === 'saved' && !searching && (
                <div className="dp-map-saved-list">
                  <small>{t.local}</small>
                  {saved.length === 0 ? (
                    <p>{t.noSaved}</p>
                  ) : (
                    saved.map((p) => (
                      <button key={p.id} onClick={() => selectPoint(p)}>
                        <Bookmark size={16} />
                        {p.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="dp-map-tools">
              <button
                title={t.layers}
                aria-label={t.layers}
                aria-expanded={layerMenu}
                onClick={() => setLayerMenu((v) => !v)}
              >
                <Info size={22} />
              </button>
              <button
                aria-label={threeD ? '2D' : '3D'}
                aria-pressed={threeD}
                onClick={() => setThreeD((v) => !v)}
              >
                {threeD ? '2D' : '3D'}
              </button>
              <button
                aria-label={geoBusy ? t.cancel : t.location}
                title={geoBusy ? t.cancel : t.location}
                onClick={locate}
              >
                {geoBusy ? (
                  <LoaderCircle className="dp-spin" size={23} />
                ) : (
                  <Navigation size={23} />
                )}
              </button>
            </div>
            {layerMenu && (
              <div className="dp-map-layer-menu">
                <p>OpenStreetMap · Protomaps</p>
                <p>
                  {t.data}: {pkg.manifest?.dataDate}
                </p>
                <p>{t.height}</p>
              </div>
            )}
            {message && (
              <div className="dp-map-message" role="status">
                {message}
                <button aria-label={t.close} onClick={() => setMessage(null)}>
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="dp-map-data">
              <Download size={13} />
              <span>
                {t.ready}
                <small>
                  {t.data}: {pkg.manifest?.dataDate}
                  {accuracy !== null ? ` · ${t.accuracy} ±${accuracy} ${t.meters}` : ''}
                </small>
              </span>
            </div>
          </>
        )}
      </div>
      {(plan || point) && pkg.status === 'ready' && (
        <div className="dp-map-sheet">
          <div className="dp-map-grip" />
          <button className="dp-map-sheet-close" aria-label={t.close} onClick={closeSelection}>
            <X size={20} />
          </button>
          {plan ? (
            <>
              <h2>{plan.title}</h2>
              <p>
                {planDate(plan.date, locale)} · {plan.time}
              </p>
              <p className="dp-map-muted">
                <MapPin size={16} />
                {plan.place?.label}
              </p>
              <div className="dp-map-members">
                {plan.members.slice(0, 4).map((member) => (
                  <span key={member.uid} title={member.displayName}>
                    {member.displayName.slice(0, 1).toLocaleUpperCase(locale)}
                  </span>
                ))}
                <small>{plan.members.map((m) => m.displayName).join(', ')}</small>
              </div>
              <button className="dp-map-primary" onClick={() => onSelectPlan(plan)}>
                {t.open}
              </button>
            </>
          ) : (
            point && (
              <>
                <label className="dp-map-place-label">
                  <span>{t.point}</span>
                  <input
                    aria-label={t.point}
                    maxLength={120}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <p className="dp-map-muted">
                  {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
                </p>
                <div className="dp-map-sheet-actions">
                  {onPickPlace && (
                    <button
                      className="dp-map-primary"
                      onClick={() => onPickPlace({ ...point, label: label.trim() || t.point })}
                    >
                      <Check size={18} />
                      {t.select}
                    </button>
                  )}
                  {userId && (
                    <button className="dp-map-secondary" onClick={() => void toggleSaved()}>
                      {alreadySaved ? <Trash2 size={18} /> : <Bookmark size={18} />}
                      <span>{alreadySaved ? t.remove : t.save}</span>
                    </button>
                  )}
                </div>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
export default MapScreen;
