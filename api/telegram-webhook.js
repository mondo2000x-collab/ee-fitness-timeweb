const { getAccessToken, getValues, appendValues, updateValues } = require('../lib/google');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const COACH_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BTN_KBZHU = '🍽 КБЖУ';
const BTN_WORKOUT = '🏋 Тренировка';
const BTN_PROGRESS = '📏 Замеры';
const BTN_HELP = '❓ Помощь';

const MAIN_MENU = {
  keyboard: [
    [{ text: BTN_KBZHU }, { text: BTN_WORKOUT }],
    [{ text: BTN_PROGRESS }, { text: BTN_HELP }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const CANCEL_INLINE = { inline_keyboard: [[{ text: '✖️ Отмена', callback_data: 'cancel' }]] };

const HELP_TEXT =
  'Чем могу помочь:\n\n' +
  BTN_KBZHU + ' — отчёт по питанию за сегодня (бот сам спросит калории, белки, жиры, углеводы и шаги)\n\n' +
  BTN_WORKOUT + ' — отчёт по тренировке (выбираете упражнения из списка, указываете подходы, повторы и вес)\n\n' +
  BTN_PROGRESS + ' — новые замеры (вес, талия, бёдра, грудь)\n\n' +
  'Просто нажмите нужную кнопку внизу экрана — бот сам проведёт по всем шагам.\n\n' +
  'Любое другое сообщение или фото — перешлю тренеру напрямую.\n' +
  'В любой момент можно написать /cancel, чтобы прервать текущий отчёт.';

function todayRu() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '.' + mm + '.' + yyyy;
}

function tgApi(method, payload) {
  return fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
}

function sendMessage(chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApi('sendMessage', payload);
}

function answerCallback(callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = false; }
  return tgApi('answerCallbackQuery', payload);
}

function forwardMessage(fromChatId, messageId) {
  return tgApi('forwardMessage', {
    chat_id: COACH_CHAT_ID,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

async function findClientByChatId(chatId, accessToken) {
  const rows = await getValues(SHEET_ID, 'Клиенты!A2:N1000', accessToken);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const telegramChatId = row[12];
    if (telegramChatId && String(telegramChatId).trim() === String(chatId)) {
      let session = null;
      try { session = row[13] ? JSON.parse(row[13]) : null; } catch (e) { session = null; }
      return { rowIndex: i + 2, idClient: row[0], fio: row[1], phone: row[2] || '', session: session };
    }
  }
  return null;
}

async function saveSession(rowIndex, sessionObj, accessToken) {
  const value = sessionObj ? JSON.stringify(sessionObj) : '';
  await updateValues(SHEET_ID, 'Клиенты!N' + rowIndex, [value], accessToken);
}

async function findClientByNameOrId(text, accessToken) {
  const rows = await getValues(SHEET_ID, 'Клиенты!A2:N1000', accessToken);
  const trimmed = text.trim();

  if (/^\d+$/.test(trimmed)) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (String(row[0]).trim() === trimmed) {
        return { rowIndex: i + 2, idClient: row[0], fio: row[1] };
      }
    }
    return null;
  }

  const normalized = trimmed.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fio = (row[1] || '').trim().toLowerCase();
    if (fio && (fio === normalized || fio.includes(normalized) || normalized.includes(fio))) {
      return { rowIndex: i + 2, idClient: row[0], fio: row[1] };
    }
  }
  return null;
}

async function getNextClientId(accessToken) {
  const rows = await getValues(SHEET_ID, 'Клиенты!A2:A1000', accessToken);
  let maxId = 0;
  for (const row of rows) {
    const n = parseInt(row[0], 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  return maxId + 1;
}

function extractRowNumber(updatedRange) {
  const match = updatedRange.match(/![A-Z]+(\d+):/);
  return match ? parseInt(match[1], 10) : null;
}

function columnIndexToLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

async function getHeaderRow(sheetName, accessToken) {
  const rows = await getValues(SHEET_ID, sheetName + '!1:8', accessToken);
  for (const row of rows) {
    if (row.some((cell) => (cell || '').toLowerCase().trim() === 'id клиента')) {
      return row;
    }
  }
  return rows[0] || [];
}

function findHeaderIndex(headers, fragment) {
  const target = fragment.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] || '').toLowerCase().includes(target)) return i;
  }
  return -1;
}

async function findNextRowByColumnA(sheetName, accessToken) {
  const rows = await getValues(SHEET_ID, sheetName + '!A2:A5000', accessToken);
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i][0] || String(rows[i][0]).trim() === '') return i + 2;
  }
  return rows.length + 2;
}

async function setCellByHeader(sheetName, headers, fragment, rowNumber, value, accessToken) {
  const idx = findHeaderIndex(headers, fragment);
  if (idx < 0) return false;
  const letter = columnIndexToLetter(idx);
  await updateValues(SHEET_ID, sheetName + '!' + letter + rowNumber, [value], accessToken);
  return true;
}

async function linkChatId(rowIndex, chatId, accessToken) {
  await updateValues(SHEET_ID, 'Клиенты!M' + rowIndex, [String(chatId)], accessToken);
}

async function createNewClient(name, chatId, username, accessToken) {
  const nextId = await getNextClientId(accessToken);
  const contact = username ? '@' + username : '';
  const result = await appendValues(
    SHEET_ID,
    'Клиенты!A:H',
    [nextId, name, contact, todayRu(), '', 'Активен', '', ''],
    accessToken
  );
  const updatedRange = result.data && result.data.updates && result.data.updates.updatedRange;
  const rowIndex = updatedRange ? extractRowNumber(updatedRange) : null;
  if (rowIndex) {
    await updateValues(SHEET_ID, 'Клиенты!M' + rowIndex, [String(chatId)], accessToken);
  }
  return { rowIndex: rowIndex, idClient: nextId, fio: name, phone: contact };
}

function looksLikePhone(text) {
  const cleaned = text.replace(/[\s\-\(\)]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned);
}

async function savePhone(rowIndex, phoneText, accessToken) {
  await updateValues(SHEET_ID, 'Клиенты!C' + rowIndex, [phoneText.trim()], accessToken);
}

async function saveKbzhuReport(client, nums, accessToken) {
  const headers = await getHeaderRow('КБЖУ', accessToken);
  const row = await findNextRowByColumnA('КБЖУ', accessToken);
  await setCellByHeader('КБЖУ', headers, 'id клиента', row, client.idClient, accessToken);
  await setCellByHeader('КБЖУ', headers, 'дата', row, todayRu(), accessToken);
  await setCellByHeader('КБЖУ', headers, 'калории факт', row, nums.calories, accessToken);
  await setCellByHeader('КБЖУ', headers, 'белки факт', row, nums.protein, accessToken);
  await setCellByHeader('КБЖУ', headers, 'жиры факт', row, nums.fat, accessToken);
  await setCellByHeader('КБЖУ', headers, 'углеводы факт', row, nums.carbs, accessToken);
  await setCellByHeader('КБЖУ', headers, 'шаги факт', row, nums.steps, accessToken);
}

async function saveProgressReport(client, nums, accessToken) {
  const headers = await getHeaderRow('Прогресс', accessToken);
  const row = await findNextRowByColumnA('Прогресс', accessToken);
  await setCellByHeader('Прогресс', headers, 'id клиента', row, client.idClient, accessToken);
  await setCellByHeader('Прогресс', headers, 'дата замера', row, todayRu(), accessToken);
  await setCellByHeader('Прогресс', headers, 'вес', row, nums.weight, accessToken);
  if (nums.waist) await setCellByHeader('Прогресс', headers, 'талия', row, nums.waist, accessToken);
  if (nums.hips) await setCellByHeader('Прогресс', headers, 'бёдра', row, nums.hips, accessToken);
  if (nums.chest) await setCellByHeader('Прогресс', headers, 'грудь', row, nums.chest, accessToken);
}

async function getValidExerciseNames(accessToken) {
  const headers = await getHeaderRow('Справочники', accessToken);
  const idx = findHeaderIndex(headers, 'упражнени');
  if (idx < 0) return [];
  const colLetter = columnIndexToLetter(idx);
  const rows = await getValues(SHEET_ID, 'Справочники!' + colLetter + '2:' + colLetter + '1000', accessToken);
  return rows.map((r) => (r[0] || '').trim()).filter(Boolean);
}

async function saveWorkoutExercisesDetailed(client, exercises, accessToken) {
  const headers = await getHeaderRow('Тренировки', accessToken);
  const idxId = findHeaderIndex(headers, 'id клиента');
  if (idxId < 0) {
    await sendMessage(
      COACH_CHAT_ID,
      '⚠️ Не нашёл нужные колонки в листе «Тренировки». Заголовки:\n' +
      headers.map((h, i) => (i + 1) + '. ' + (h || '(пусто)')).join('\n')
    );
    return;
  }
  let row = await findNextRowByColumnA('Тренировки', accessToken);
  for (const ex of exercises) {
    await setCellByHeader('Тренировки', headers, 'id клиента', row, client.idClient, accessToken);
    await setCellByHeader('Тренировки', headers, 'дата', row, todayRu(), accessToken);
    await setCellByHeader('Тренировки', headers, 'упражнени', row, ex.name, accessToken);
    for (let s = 0; s < ex.sets.length && s < 4; s++) {
      await setCellByHeader('Тренировки', headers, 'п' + (s + 1) + ' вес', row, ex.sets[s].weight, accessToken);
      await setCellByHeader('Тренировки', headers, 'п' + (s + 1) + ' повтор', row, ex.sets[s].reps, accessToken);
    }
    await setCellByHeader('Тренировки', headers, 'статус', row, 'Выполнено', accessToken);
    row++;
  }
}

function exerciseKeyboard(validNames, hasProgress) {
  const rows = [];
  for (let i = 0; i < validNames.length; i += 2) {
    const row = [{ text: validNames[i], callback_data: 'ex:' + i }];
    if (validNames[i + 1]) row.push({ text: validNames[i + 1], callback_data: 'ex:' + (i + 1) });
    rows.push(row);
  }
  const controlRow = [];
  if (hasProgress) controlRow.push({ text: '✅ Завершить', callback_data: 'finish' });
  controlRow.push({ text: '✖️ Отмена', callback_data: 'cancel' });
  rows.push(controlRow);
  return { inline_keyboard: rows };
}

function workoutSummaryText(exercises) {
  return exercises.map((e) => {
    const setsText = e.sets.map((s, i) => (i + 1) + ') ' + s.reps + '×' + s.weight + 'кг').join(', ');
    return e.name + ': ' + setsText;
  }).join('\n');
}

function parseNumber(text) {
  const n = parseFloat(text.trim().replace(',', '.'));
  return isNaN(n) ? null : n;
}

async function startKbzhuFlow(client, accessToken) {
  const session = { mode: 'kbzhu', step: 'calories', data: {} };
  await saveSession(client.rowIndex, session, accessToken);
  await sendMessage(client.telegramChatId, 'Сколько калорий сегодня?', CANCEL_INLINE);
}

async function startProgressFlow(client, accessToken) {
  const session = { mode: 'progress', step: 'weight', data: {} };
  await saveSession(client.rowIndex, session, accessToken);
  await sendMessage(client.telegramChatId, 'Какой вес сегодня, кг?', CANCEL_INLINE);
}

async function startWorkoutFlow(client, accessToken) {
  const validNames = await getValidExerciseNames(accessToken);
  if (validNames.length === 0) {
    await sendMessage(client.telegramChatId, 'Не нашёл список упражнений в справочнике. Сообщите тренеру.');
    return;
  }
  const session = { mode: 'workout', step: 'choose_exercise', exercises: [], current: null };
  await saveSession(client.rowIndex, session, accessToken);
  await sendMessage(client.telegramChatId, 'Выберите упражнение:', exerciseKeyboard(validNames, false));
}

async function handleCallbackQuery(callbackQuery, accessToken) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  const client = await findClientByChatId(chatId, accessToken);
  if (!client || !client.session) {
    await answerCallback(callbackQuery.id, 'Эта кнопка уже неактуальна.');
    return;
  }
  client.telegramChatId = chatId;
  const session = client.session;

  if (data === 'cancel') {
    await saveSession(client.rowIndex, null, accessToken);
    await answerCallback(callbackQuery.id);
    await sendMessage(chatId, 'Отменено.', MAIN_MENU);
    return;
  }

  if (session.mode !== 'workout') {
    await answerCallback(callbackQuery.id);
    return;
  }

  if (data === 'finish') {
    if (!session.exercises || session.exercises.length === 0) {
      await answerCallback(callbackQuery.id, 'Сначала выберите хотя бы одно упражнение.');
      return;
    }
    await answerCallback(callbackQuery.id);
    await saveWorkoutExercisesDetailed(client, session.exercises, accessToken);
    await saveSession(client.rowIndex, null, accessToken);
    await sendMessage(chatId, 'Отчёт по тренировке записан, спасибо! Всего упражнений: ' + session.exercises.length + '.', MAIN_MENU);
    await sendMessage(COACH_CHAT_ID, client.fio + ' прислал(а) отчёт по тренировке:\n' + workoutSummaryText(session.exercises));
    return;
  }

  if (data.startsWith('ex:') && session.step === 'choose_exercise') {
    const validNames = await getValidExerciseNames(accessToken);
    const idx = parseInt(data.slice(3), 10);
    const name = validNames[idx];
    if (!name) {
      await answerCallback(callbackQuery.id, 'Список обновился, начните заново через кнопку «Тренировка».');
      return;
    }
    session.current = { name: name, totalSets: null, collected: [] };
    session.step = 'ask_sets';
    await saveSession(client.rowIndex, session, accessToken);
    await answerCallback(callbackQuery.id);
    await sendMessage(chatId, 'Упражнение: ' + name + '\nСколько было подходов? (максимум 4)', CANCEL_INLINE);
    return;
  }

  await answerCallback(callbackQuery.id);
}

async function handleKbzhuStep(client, text, accessToken) {
  const chatId = client.telegramChatId;
  const session = client.session;
  const value = parseNumber(text);

  if (value === null) {
    await sendMessage(chatId, 'Напишите число, например: 1800', CANCEL_INLINE);
    return;
  }

  const steps = ['calories', 'protein', 'fat', 'carbs', 'steps'];
  const prompts = {
    protein: 'Сколько белков, г?',
    fat: 'Сколько жиров, г?',
    carbs: 'Сколько углеводов, г?',
    steps: 'Сколько шагов?',
  };

  session.data[session.step] = value;
  const currentIdx = steps.indexOf(session.step);
  const nextStep = steps[currentIdx + 1];

  if (nextStep) {
    session.step = nextStep;
    await saveSession(client.rowIndex, session, accessToken);
    await sendMessage(chatId, prompts[nextStep], CANCEL_INLINE);
    return;
  }

  await saveKbzhuReport(client, session.data, accessToken);
  await saveSession(client.rowIndex, null, accessToken);
  await sendMessage(
    chatId,
    'Записал! Калории: ' + session.data.calories + ', Б/Ж/У: ' + session.data.protein + '/' + session.data.fat + '/' + session.data.carbs + ', шаги: ' + session.data.steps + '.',
    MAIN_MENU
  );
  await sendMessage(COACH_CHAT_ID, client.fio + ' прислал(а) отчёт КБЖУ за сегодня.');
}

async function handleProgressStep(client, text, accessToken) {
  const chatId = client.telegramChatId;
  const session = client.session;
  const value = parseNumber(text);

  if (value === null) {
    await sendMessage(chatId, 'Напишите число, например: 77.5 (или 0, если не измеряли)', CANCEL_INLINE);
    return;
  }

  const steps = ['weight', 'waist', 'hips', 'chest'];
  const prompts = {
    waist: 'Обхват талии, см? (или 0, если не измеряли)',
    hips: 'Обхват бёдер, см? (или 0)',
    chest: 'Обхват груди, см? (или 0)',
  };

  session.data[session.step] = value;
  const currentIdx = steps.indexOf(session.step);
  const nextStep = steps[currentIdx + 1];

  if (nextStep) {
    session.step = nextStep;
    await saveSession(client.rowIndex, session, accessToken);
    await sendMessage(chatId, prompts[nextStep], CANCEL_INLINE);
    return;
  }

  await saveProgressReport(client, session.data, accessToken);
  await saveSession(client.rowIndex, null, accessToken);
  await sendMessage(chatId, 'Замеры записаны, спасибо!', MAIN_MENU);
  await sendMessage(COACH_CHAT_ID, client.fio + ' прислал(а) новые замеры.');
}

async function handleWorkoutStep(client, text, accessToken) {
  const chatId = client.telegramChatId;
  const session = client.session;

  if (session.step === 'ask_sets') {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || n < 1) {
      await sendMessage(chatId, 'Напишите число подходов, например: 3', CANCEL_INLINE);
      return;
    }
    session.current.totalSets = Math.min(n, 4);
    session.step = 'ask_set_data';
    await saveSession(client.rowIndex, session, accessToken);
    const note = n > 4 ? ' (в таблице максимум 4 подхода, беру первые 4)' : '';
    await sendMessage(chatId, 'Подход 1' + note + ': повторы и вес через запятую (например: 10, 60)', CANCEL_INLINE);
    return;
  }

  if (session.step === 'ask_set_data') {
    const parts = text.split(',').map((p) => p.trim());
    const reps = parseInt(parts[0], 10);
    const weight = parseFloat((parts[1] || '').replace(',', '.'));
    if (parts.length < 2 || isNaN(reps) || isNaN(weight)) {
      await sendMessage(chatId, 'Не разобрал. Пришлите так: повторы, вес — например: 10, 60', CANCEL_INLINE);
      return;
    }
    session.current.collected.push({ reps: reps, weight: weight });

    if (session.current.collected.length < session.current.totalSets) {
      const nextNum = session.current.collected.length + 1;
      await saveSession(client.rowIndex, session, accessToken);
      await sendMessage(chatId, 'Подход ' + nextNum + ': повторы и вес (например: 10, 60)', CANCEL_INLINE);
      return;
    }

    session.exercises = session.exercises || [];
    session.exercises.push({ name: session.current.name, sets: session.current.collected });
    session.current = null;
    session.step = 'choose_exercise';
    await saveSession(client.rowIndex, session, accessToken);

    const validNames = await getValidExerciseNames(accessToken);
    await sendMessage(chatId, 'Упражнение записано. Выберите следующее или завершите отчёт:', exerciseKeyboard(validNames, true));
    return;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  const update = req.body || {};

  try {
    const accessToken = await getAccessToken();

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, accessToken);
      res.status(200).send('ok');
      return;
    }

    const message = update.message;
    if (!message) {
      res.status(200).send('ok');
      return;
    }

    const chatId = message.chat.id;
    const text = (message.text || '').trim();

    let client = await findClientByChatId(chatId, accessToken);

    if (!client) {
      if (text.toLowerCase() === '/start') {
        await sendMessage(chatId, 'Здравствуйте! Напишите, пожалуйста, ваше имя и фамилию (или ваш ID клиента, если тренер его сообщил), чтобы я вас нашёл.');
        res.status(200).send('ok');
        return;
      }
      if (!text || text.length < 2) {
        await sendMessage(chatId, 'Напишите, пожалуйста, ваше имя и фамилию текстом.');
        res.status(200).send('ok');
        return;
      }

      let found = await findClientByNameOrId(text, accessToken);
      let isNew = false;
      if (!found) {
        found = await createNewClient(text, chatId, message.from && message.from.username, accessToken);
        isNew = true;
      } else {
        await linkChatId(found.rowIndex, chatId, accessToken);
      }

      await sendMessage(
        chatId,
        (isNew ? 'Записал вас, ' : 'Отлично, ') + found.fio + '! Вы подключены.\n\n' +
        (isNew ? 'Пришлите, пожалуйста, ваш номер телефона для связи (например: +7 900 111-22-33).\n\n' : '') +
        HELP_TEXT,
        MAIN_MENU
      );

      if (isNew) {
        await sendMessage(COACH_CHAT_ID, 'Новый клиент через бота: ' + found.fio + ' (ID ' + found.idClient + '). Заполните тариф и остальные данные в таблице.');
      }
      res.status(200).send('ok');
      return;
    }

    client.telegramChatId = chatId;
    const lowerText = text.toLowerCase();

    if (lowerText === '/cancel') {
      if (client.session) await saveSession(client.rowIndex, null, accessToken);
      await sendMessage(chatId, 'Отменено.', MAIN_MENU);
      res.status(200).send('ok');
      return;
    }

    // активная пошаговая сессия — ведём её дальше
    if (client.session && client.session.mode) {
      if (client.session.mode === 'kbzhu') await handleKbzhuStep(client, text, accessToken);
      else if (client.session.mode === 'progress') await handleProgressStep(client, text, accessToken);
      else if (client.session.mode === 'workout') await handleWorkoutStep(client, text, accessToken);
      res.status(200).send('ok');
      return;
    }

    if (lowerText === '/help' || lowerText === '/start' || text === BTN_HELP) {
      await sendMessage(chatId, HELP_TEXT, MAIN_MENU);
      res.status(200).send('ok');
      return;
    }

    if (!client.phone && looksLikePhone(text)) {
      await savePhone(client.rowIndex, text, accessToken);
      await sendMessage(chatId, 'Записал номер, спасибо!', MAIN_MENU);
      res.status(200).send('ok');
      return;
    }

    if (text === BTN_KBZHU || lowerText.startsWith('кбжу')) {
      await startKbzhuFlow(client, accessToken);
      res.status(200).send('ok');
      return;
    }

    if (text === BTN_PROGRESS || lowerText.startsWith('замер')) {
      await startProgressFlow(client, accessToken);
      res.status(200).send('ok');
      return;
    }

    if (text === BTN_WORKOUT || lowerText.startsWith('тренировка')) {
      await startWorkoutFlow(client, accessToken);
      res.status(200).send('ok');
      return;
    }

    await sendMessage(COACH_CHAT_ID, 'Сообщение от ' + client.fio + ':');
    await forwardMessage(chatId, message.message_id);
    await sendMessage(chatId, 'Передал тренеру, спасибо!', MAIN_MENU);

    res.status(200).send('ok');
  } catch (err) {
    console.log('Webhook error:', err.message);
    try {
      await sendMessage(COACH_CHAT_ID, '⚠️ Ошибка в боте при обработке сообщения: ' + err.message);
    } catch (notifyErr) {
      console.log('Failed to notify coach about error:', notifyErr.message);
    }
    res.status(200).send('ok');
  }
};
