# Serverless-прием заявок с сайта через Yandex Cloud и Telegram

Готовая serverless-система для приема заявок с сайта без Make, n8n и других внешних webhook-сервисов. Особенно актуально для РФ, где у части пользователей могут нестабильно работать зарубежные webhook-сервисы или внешние интеграции.

Проект принимает заявки с сайта, отправляет их в Telegram-чат менеджеров, добавляет кнопку **«Принять»**, сохраняет статус заявки в YDB и через 5 минут отправляет напоминание, если заявку никто не взял в работу.

По стоимости такая схема на небольшом и среднем объеме обычно получается либо бесплатной, либо очень дешевой.

Подходит для интернет-магазинов, лендингов, сервисных сайтов и любых форм, где важно не потерять заявку.

---

## Что умеет

- Принимать заявки с сайта через HTTP-запрос.
- Отправлять уведомления в Telegram.
- Добавлять inline-кнопку **«Принять»**.
- Записывать заявку в YDB со статусом `pending`.
- Менять статус заявки на `accepted`, когда менеджер нажал кнопку.
- Показывать, кто именно принял заявку.
- Через 5 минут отправлять напоминание, если заявку никто не принял.
- Поддерживать разные типы заявок с разными текстами сообщений.

---

## Поддерживаемые сценарии

Сейчас предусмотрены 4 типа заявок:

| Тип заявки | Описание | Кнопка в Telegram | Напоминание |
|---|---|---|---|
| `callback_request` | Обратный звонок | `✅ Принять звонок` | `🚨 Звонок не принят 5 минут` |
| `one_click_order` | Заказ в один клик | `✅ Принять заказ` | `🚨 Заказ в один клик не принят 5 минут` |
| `preorder_request` | Предзаказ товара | `✅ Принять предзаказ` | `🚨 Предзаказ не принят 5 минут` |
| `alternative_request` | Подбор альтернативы | `✅ Принять подбор` | `🚨 Подбор альтернативы не принят 5 минут` |

![Пример уведомлений: первичных и повторных](Example.jpg)

---

## Примерная стоимость

На небольшом объеме такая схема обычно укладывается в бесплатные лимиты Yandex Cloud.

На одну заявку примерно приходится:

- 1 вызов функции `create-request`;
- 1 отправка сообщения в Telegram;
- 1 запись в YDB;
- 1 отправка сообщения в Message Queue;
- 1 вызов `reminder` через 5 минут;
- 1 чтение из YDB;
- иногда 1 вызов `accept-request` при нажатии кнопки;
- 1 обновление записи в YDB.

Примерно:

| Заявок в месяц | Вызовы функций | Запросы к очереди | Операции YDB | Ориентировочная стоимость |
|---:|---:|---:|---:|---:|
| 100 | до 300 | около 100 | несколько сотен | обычно 0 ₽ |
| 1 000 | до 3 000 | около 1 000 | несколько тысяч | обычно 0 ₽ |
| 10 000 | до 30 000 | около 10 000 | десятки тысяч | обычно 0 ₽ |
| 100 000 | до 300 000 | около 100 000 | сотни тысяч | близко к 0 ₽ или очень дешево |

Почему так:

- Cloud Functions дают бесплатный ежемесячный объем: первые 1 000 000 вызовов и 10 ГБ×час выполнения.
- Message Queue дает первые 100 000 запросов к очереди в месяц бесплатно.
- YDB Serverless дает бесплатный ежемесячный объем операций и небольшой объем хранения.
- Telegram Bot API отдельно не тарифицируется.

---

## Архитектура

```text
Сайт
  ↓ POST-запрос
Cloud Function #1: create-request
  ├─→ Telegram: сообщение с кнопкой “Принять”
  ├─→ YDB: запись заявки со статусом pending
  └─→ Message Queue: request_id с задержкой 5 минут

Telegram inline-кнопка
  ↓ webhook
Cloud Function #2: accept-request
  ├─→ YDB: pending → accepted
  └─→ Telegram: “Заявка принята”, кто принял

Message Queue через 5 минут
  ↓ trigger
Cloud Function #3: reminder
  ├─→ читает заявку из YDB
  ├─→ если status = pending, отправляет напоминание
  └─→ если status = accepted, ничего не делает
```

---

## Из чего состоит проект

```text
functions/
  create-request/
    index.js
    package.json

  accept-request/
    index.js
    package.json

  reminder/
    index.js
    package.json

examples/
  frontend-payloads.js

ydb-schema.sql
.env.example
README.md
```

---

## Требования

Нужны:

- аккаунт в Yandex Cloud;
- Telegram-бот;
- Telegram-чат или группа для заявок;
- Yandex Cloud Functions;
- Yandex Managed Service for YDB в режиме Serverless;
- Yandex Message Queue;
- триггер Message Queue → Cloud Function.

---

## Быстрый запуск

### 1. Создать Telegram-бота

1. Откройте BotFather в Telegram.
2. Создайте нового бота.
3. Сохраните токен бота.

Пример переменной:

```env
TELEGRAM_BOT_TOKEN=1234567890:your_bot_token_here
```

---

### 2. Добавить бота в Telegram-чат

1. Создайте группу или используйте существующую.
2. Добавьте туда бота.
3. Получите `chat_id` группы.
4. Добавьте его в переменные окружения.

```env
TELEGRAM_CHAT_ID=-1001234567890
```

Для тестового чата можно использовать отдельную переменную:

```env
TELEGRAM_CHAT_ID_TEST=-1009876543210
```

---

### 3. Создать YDB Serverless базу

В Yandex Cloud создайте базу YDB в режиме **Serverless**.

Нужны будут:

```env
YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135
YDB_DATABASE=/ru-central1/your-cloud-id/your-folder-id/your-database-id
```

---

### 4. Создать таблицу в YDB

Пример схемы:

```sql
CREATE TABLE callback_requests (
  request_id Utf8 NOT NULL,
  request_type Utf8,
  status Utf8,
  phone Utf8,
  name Utf8,
  comment Utf8,
  page_url Utf8,
  product_name Utf8,
  product_price Utf8,
  message_id Utf8,
  created_at Utf8,
  accepted_by Utf8,
  accepted_at Utf8,
  PRIMARY KEY (request_id)
);
```

---

### 5. Создать Message Queue

Создайте стандартную очередь, например:

```text
callback-reminders
```

Рекомендуемые настройки:

```text
Тип: Standard
Задержка доставки: 300 секунд
Срок хранения сообщений: 4 дня
Размер группы для триггера: 1
```

Сохраните URL очереди:

```env
YMQ_QUEUE_URL=https://message-queue.api.cloud.yandex.net/your-folder-id/your-queue-id/callback-reminders
```

---

### 6. Создать сервисный аккаунт

Создайте сервисный аккаунт, например:

```text
lead-router-sa
```

Для простого запуска можно выдать ему роли:

```text
functions.functionInvoker
ymq.writer
editor
```

`editor` можно использовать на старте для упрощения настройки триггера. После проверки лучше заменить его на более точные права.

---

### 7. Создать статический ключ доступа

Для отправки сообщений в Message Queue через AWS SQS SDK нужен статический ключ сервисного аккаунта.

Добавьте в переменные:

```env
AWS_REGION=ru-central1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
```

---

## Переменные окружения

### `create-request`

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_CHAT_ID_TEST=

YDB_ENDPOINT=
YDB_DATABASE=

YMQ_QUEUE_URL=
AWS_REGION=ru-central1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

### `accept-request`

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_CHAT_ID_TEST=

YDB_ENDPOINT=
YDB_DATABASE=
```

### `reminder`

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_CHAT_ID_TEST=

YDB_ENDPOINT=
YDB_DATABASE=
```

---

## Функция 1: `create-request`

Эта функция принимает заявку с сайта.

Что делает:

1. Проверяет входящие данные.
2. Определяет тип заявки.
3. Отправляет сообщение в Telegram.
4. Записывает заявку в YDB со статусом `pending`.
5. Кладет `request_id` в Message Queue.

Поддерживаемые типы:

```text
callback_request
one_click_order
preorder_request
alternative_request
```

---

## Функция 2: `accept-request`

Эта функция принимает webhook от Telegram.

Что делает:

1. Получает нажатие inline-кнопки.
2. Достает `request_id`.
3. Находит заявку в YDB.
4. Меняет статус на `accepted`.
5. Сохраняет, кто принял заявку.
6. Убирает кнопку из исходного сообщения.
7. Отправляет сообщение в чат.

Пример для звонка:

```text
✅ Звонок принят

Принял: @username
```

Пример для заказа:

```text
✅ Заказ принят

Принял: @username
```

---

## Функция 3: `reminder`

Эта функция вызывается триггером Message Queue через 5 минут.

Что делает:

1. Получает `request_id` из очереди.
2. Читает заявку из YDB.
3. Если `status = accepted`, ничего не делает.
4. Если `status = pending`, отправляет напоминание в Telegram.

Примеры напоминаний:

```text
🚨 Звонок не принят 5 минут
```

```text
🚨 Заказ в один клик не принят 5 минут
```

```text
🚨 Предзаказ не принят 5 минут
```

```text
🚨 Подбор альтернативы не принят 5 минут
```

---

## Настройка Telegram webhook для кнопок

После создания функции `accept-request` нужно привязать к ней Telegram webhook.

URL функции будет выглядеть примерно так:

```text
https://functions.yandexcloud.net/id-вашей-функции
```

Webhook должен принимать `callback_query`.

Пример запроса:

```text
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https%3A%2F%2Ffunctions.yandexcloud.net%2Fyour-function-id&allowed_updates=%5B%22callback_query%22%5D
```

Проверить webhook можно так:

```text
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

В ответе должен быть URL функции и:

```json
{
  "allowed_updates": ["callback_query"]
}
```

---

## Настройка триггера Message Queue

Создайте триггер:

```text
Тип: Message Queue
Очередь: callback-reminders
Запускаемый ресурс: Function
Функция: reminder
Размер группы: 1
Время ожидания: 0
```

После создания триггер может начать работать не мгновенно. Иногда нужно подождать несколько минут.

---

### Обратный звонок

```js
fetch('https://functions.yandexcloud.net/your-create-request-function-id', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'callback_request',
    name: 'Дмитрий',
    phone: '+7 (999) 123-45-67',
    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  }),
});
```

---

### Заказ в один клик

```js
fetch('https://functions.yandexcloud.net/your-create-request-function-id', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'one_click_order',
    full_name: 'Дмитрий',
    phone: '+7 (999) 123-45-67',
    comment: 'Позвонить после 14:00',
    product_name: 'Бензопила Makita',
    product_price: '33 890 ₽',
    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  }),
});
```

---

### Предзаказ

```js
fetch('https://functions.yandexcloud.net/your-create-request-function-id', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'preorder_request',
    name: 'Дмитрий',
    phone: '+7 (999) 123-45-67',
    product_name: 'Мойка высокого давления',
    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  }),
});
```

---

### Подбор альтернативы

```js
fetch('https://functions.yandexcloud.net/your-create-request-function-id', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'alternative_request',
    name: 'Дмитрий',
    phone: '+7 (999) 123-45-67',
    product_name: 'Товар, которого нет в наличии',
    page_url: window.location.href,
    page_title: document.title,
    submitted_at: new Date().toLocaleString(),
  }),
});
```

---

## Пример сообщений в Telegram

### Обратный звонок

```text
📞 Новая заявка на обратный звонок

Имя: Дмитрий
Телефон: +7 (999) 123-45-67

Страница: https://example.ru/product/example
```

### Заказ в один клик

```text
❗ Новый заказ в один клик

Данные о клиенте:
ФИО: Дмитрий
Телефон: +7 (999) 123-45-67
Комментарий: Позвонить после 14:00

Данные о товаре:
Товар: Бензопила Makita
Цена: 33 890 ₽

Страница: https://example.ru/product/example
```

### Предзаказ

```text
📦 Новая заявка на предзаказ

Имя: Дмитрий
Телефон: +7 (999) 123-45-67

Товар: Мойка высокого давления
```

### Подбор альтернативы

```text
🔎 Новая заявка на подбор альтернативы

Имя: Дмитрий
Телефон: +7 (999) 123-45-67

Товар: Товар, которого нет в наличии
```

---

## Безопасность

Перед публикацией проекта или деплоем обязательно:

- не храните токены и ключи в коде!;
- используйте переменные окружения;
- не коммитьте `.env`;
- не выкладывайте реальные номера телефонов клиентов;
- не выкладывайте реальные `chat_id`, токены ботов и AWS static keys;
- после тестов лучше заменить широкую роль `editor` на более точные роли.

---

## Что можно доработать

Идеи для развития:

- добавить повторное напоминание через 15 минут;
- добавить разные Telegram-чаты для разных типов заявок, на разные отделы;
- добавить логирование источника заявки и UTM-меток;
- добавить статус `expired`;
- добавить простую админку заявок;
- добавить отправку в CRM;
- добавить скрытую защиту от спама;
- добавить прочие функции - inline кнопки к каждой заявке.

---

## Лицензия

MIT
