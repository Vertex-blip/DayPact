import { useEffect } from 'react';
import { Check, Download, LoaderCircle, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Locale } from '../../shared/contracts';
import {
  cancelMapDownload,
  ensureMapPackage,
  formatMB,
  inspectMapPackage,
  keepMapOnDevice,
  removeMapPackage,
  useMapPackage,
} from './offlinePackage';
import './map.css';

const text = {
  kk: {
    title: 'Астана',
    ready: 'Құрылғыда сақталған',
    description:
      'Көшелер, ғимараттар және картадағы орындар. Жүктегеннен кейін интернетсіз ашылады.',
    download: 'Жүктеу',
    retry: 'Қайта көру',
    cancel: 'Болдырмау',
    remove: 'Картаны өшіру',
    keep: 'Құрылғыда сақтап қалу',
    kept: 'Тұрақты сақтау рұқсаты берілген',
    keepHelp:
      'Браузер рұқсат берсе, карта жадтан автоматты өшірілмейді. Құрылғы баптауларынан деректерді тазаласаңыз, қайта жүктеу керек.',
    checking: 'Тексерілуде',
    loading: 'Жүктелуде',
    source: 'Деректер күні',
    accuracy:
      'Картада OpenStreetMap деректеріндегі орындар көрсетіледі; барлық мекеме қамтылмауы мүмкін.',
    offline: 'Интернет жоқ. Карта пакетін жүктеу үшін қосылыңыз.',
    quota: 'Құрылғыда бос орын жеткіліксіз.',
    integrity: 'Жүктелген файл толық емес. Қайта жүктеңіз.',
    unsupported: 'Бұл браузер офлайн картаны сақтай алмайды.',
    network: 'Жүктеу аяқталмады. Интернетті тексеріп, қайталап көріңіз.',
  },
  ru: {
    title: 'Астана',
    ready: 'Сохранена на устройстве',
    description: 'Улицы, здания и места на карте. После загрузки открывается без интернета.',
    download: 'Скачать',
    retry: 'Повторить',
    cancel: 'Отмена',
    remove: 'Удалить карту',
    keep: 'Сохранять на устройстве',
    kept: 'Разрешено постоянное хранение',
    keepHelp:
      'Если браузер разрешит, карта не будет автоматически удаляться из хранилища. После очистки данных браузера потребуется повторная загрузка.',
    checking: 'Проверяем',
    loading: 'Загрузка',
    source: 'Дата данных',
    accuracy: 'На карте отображаются места из OpenStreetMap; часть заведений может отсутствовать.',
    offline: 'Нет интернета. Подключитесь, чтобы скачать пакет карты.',
    quota: 'Недостаточно места на устройстве.',
    integrity: 'Файл загрузился не полностью. Повторите загрузку.',
    unsupported: 'Этот браузер не поддерживает хранение офлайн-карт.',
    network: 'Загрузка не завершена. Проверьте интернет и повторите.',
  },
};
export function OfflineMapsSettings({ locale }: { locale: Locale }) {
  const t = text[locale],
    pkg = useMapPackage();
  useEffect(() => {
    void inspectMapPackage();
  }, []);
  const busy = pkg.status === 'checking' || pkg.status === 'downloading';
  const error =
    pkg.error === 'offline'
      ? t.offline
      : pkg.error === 'quota'
        ? t.quota
        : pkg.error === 'integrity'
          ? t.integrity
          : pkg.error === 'unsupported'
            ? t.unsupported
            : t.network;
  return (
    <section className="dp-offline-settings">
      <div className="dp-offline-heading">
        <div className="dp-offline-badge">
          {pkg.status === 'ready' ? <Check size={25} /> : <Download size={25} />}
        </div>
        <div>
          <h2>{t.title}</h2>
          <span>
            {pkg.status === 'ready'
              ? t.ready
              : busy
                ? pkg.status === 'checking'
                  ? t.checking
                  : t.loading
                : pkg.total
                  ? formatMB(pkg.total)
                  : t.download}
          </span>
        </div>
      </div>
      <p>{t.description}</p>
      {pkg.manifest && (
        <p className="dp-map-muted">
          {formatMB(pkg.manifest.totalBytes)} · {t.source}: {pkg.manifest.dataDate}
        </p>
      )}
      {pkg.status === 'downloading' && (
        <div className="dp-offline-progress" role="status">
          <progress aria-label={t.loading} max={pkg.total} value={pkg.loaded} />
          <span>
            {formatMB(pkg.loaded)} / {formatMB(pkg.total)}
          </span>
        </div>
      )}
      {pkg.status === 'error' && (
        <p role="alert" className="dp-map-error">
          {error}
        </p>
      )}
      {busy ? (
        <button className="dp-map-secondary" onClick={cancelMapDownload}>
          <X size={18} />
          {t.cancel}
        </button>
      ) : pkg.status === 'ready' ? (
        <>
          <button
            className="dp-map-secondary"
            onClick={() => void keepMapOnDevice().catch(() => {})}
          >
            <ShieldCheck size={18} />
            {pkg.persistent ? t.kept : t.keep}
          </button>
          <p className="dp-offline-small">{t.keepHelp}</p>
          <button
            className="dp-map-text-button dp-map-danger"
            onClick={() => void removeMapPackage().catch(() => {})}
          >
            <Trash2 size={17} />
            {t.remove}
          </button>
        </>
      ) : (
        <button className="dp-map-primary" onClick={() => void ensureMapPackage().catch(() => {})}>
          <Download size={18} />
          {pkg.status === 'error' ? t.retry : t.download}
        </button>
      )}
      {pkg.status === 'checking' && <LoaderCircle className="dp-spin" aria-hidden="true" />}
      <p className="dp-offline-small">{t.accuracy}</p>
      <p className="dp-offline-small">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          © OpenStreetMap contributors
        </a>{' '}
        ·{' '}
        <a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">
          Protomaps
        </a>
      </p>
    </section>
  );
}
export default OfflineMapsSettings;
