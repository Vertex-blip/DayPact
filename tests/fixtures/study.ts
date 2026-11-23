import type { StudyData, StudyKind, StudyLesson } from '../../src/shared/study';

/** Synthetic timetable fixture. No real student, classroom or teacher information. */
export function createStudySeed(): StudyData {
  let sequence = 0;
  const lessons: StudyLesson[] = [];
  const add = (
    weekday: number,
    starts: string[],
    title: string,
    teacher: string,
    room: string,
    kind: StudyKind = 'practice',
    online = false,
  ) => {
    for (const startTime of starts) {
      const endMinute = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)) + 50;
      lessons.push({
        id: `e0f8a222-d4c1-4000-8000-${String(++sequence).padStart(12, '0')}`,
        weekday,
        startTime,
        endTime: `${String(Math.floor(endMinute / 60)).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}`,
        title,
        teacher,
        room,
        campus: online ? '' : 'Учебный корпус',
        kind,
        format: online ? 'online' : 'campus',
        url: '',
      });
    }
  };
  const maths = 'Учебная математика';
  const architecture = 'Строение тестовой системы';
  const backend = 'Учебный веб-курс';
  const storage = 'Учебное хранилище';
  const mobile = 'Учебная мобильная разработка';
  add(1, ['08:00', '09:00'], maths, 'Онлайн-курс 1', '', 'lecture', true);
  add(1, ['13:05'], maths, 'Преподаватель А.', 'A1.1.101');
  add(1, ['14:00', '15:00'], architecture, 'Преподаватель Б.', 'A1.3.202 lab');
  add(1, ['16:00', '17:00'], backend, 'Преподаватель В.', 'A1.2.303');
  add(1, ['18:00', '19:00'], 'Учебный язык', 'Преподаватель Г.', 'A1.2.404');
  add(2, ['13:05'], storage, 'Преподаватель Д.', 'A1.2.505');
  add(2, ['14:00', '15:00'], maths, 'Преподаватель А.', 'A1.1.606');
  add(3, ['14:00', '15:00'], storage, 'Преподаватель Д.', 'A1.1.707');
  add(3, ['16:00', '17:00'], mobile, 'Преподаватель Е.', 'A1.1.808');
  add(4, ['13:05'], mobile, 'Преподаватель Е.', 'A1.1.808');
  add(4, ['14:00', '15:00'], storage, 'Преподаватель Ж.', 'A1.3.909', 'lecture');
  add(4, ['16:00', '17:00'], backend, 'Преподаватель З.', 'A1.3.110', 'lecture');
  add(4, ['18:00'], backend, 'Преподаватель В.', 'A1.2.303');
  add(5, ['17:00'], architecture, 'Преподаватель Б.', 'A1.3.202 lab');
  return {
    term: {
      title: 'Учебный триместр · 2026–2027',
      institution: 'Test University',
      course: '2',
      startDate: '2026-12-07',
      endDate: '2027-02-13',
      timeZone: 'Asia/Almaty',
      remindMinutes: 15,
      roomInPush: false,
      periods: [
        {
          id: 'e0f8a222-d4c1-4000-9000-000000000001',
          title: 'Midterm',
          kind: 'assessment',
          startDate: '2027-01-04',
          endDate: '2027-01-09',
        },
        {
          id: 'e0f8a222-d4c1-4000-9000-000000000002',
          title: 'Endterm',
          kind: 'assessment',
          startDate: '2027-02-08',
          endDate: '2027-02-13',
        },
        {
          id: 'e0f8a222-d4c1-4000-9000-000000000003',
          title: 'Finals',
          kind: 'exams',
          startDate: '2027-02-15',
          endDate: '2027-02-27',
        },
        {
          id: 'e0f8a222-d4c1-4000-9000-000000000004',
          title: 'Каникулы',
          kind: 'vacation',
          startDate: '2027-03-01',
          endDate: '2027-03-13',
        },
      ],
      holidays: [
        { date: '2026-12-16', title: 'День Независимости' },
        { date: '2027-01-01', title: 'Новый год' },
        { date: '2027-01-02', title: 'Новый год' },
        { date: '2027-01-07', title: 'Рождество' },
        { date: '2027-03-08', title: 'Международный женский день' },
      ],
      incompleteDays: [
        {
          weekday: 3,
          expectedCount: 6,
          firstTime: '14:00',
          note: 'Пример неполного дня: известны четыре занятия из шести.',
        },
        {
          weekday: 6,
          expectedCount: null,
          firstTime: '11:00',
          note: 'Пример дня с известным временем начала и неизвестными занятиями.',
        },
        {
          weekday: 7,
          expectedCount: null,
          firstTime: null,
          note: 'Кесте берілмеген / Расписание не предоставлено.',
        },
      ],
    },
    lessons,
    overrides: [],
  };
}
