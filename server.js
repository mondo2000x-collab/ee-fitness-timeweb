const express = require('express');
const path = require('path');
const cron = require('node-cron');

const leadHandler = require('./api/lead');
const telegramHandler = require('./api/telegram-webhook');
const { handler: reminderHandler, runDailyReminder } = require('./api/daily-reminder');

const app = express();
app.use(express.json());

// Отдаёт index.html, privacy.html, images/, favicon.ico и т.д. как обычный сайт
app.use(express.static(path.join(__dirname)));

app.post('/api/lead', leadHandler);
app.post('/api/telegram-webhook', telegramHandler);
app.get('/api/daily-reminder', reminderHandler);

// Ежедневное напоминание в 20:00 по Москве (17:00 UTC) — без внешнего cron-сервиса,
// сервер сам вызывает нужную функцию по расписанию
cron.schedule('0 17 * * *', async () => {
  try {
    const result = await runDailyReminder();
    console.log('Daily reminder sent, count:', result.remindersSent);
  } catch (err) {
    console.log('Daily reminder failed:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('E&E Fitness server running on port ' + PORT);
});
