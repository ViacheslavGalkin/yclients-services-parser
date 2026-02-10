const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const PARTNER_TOKEN = process.env.PARTNER_TOKEN;
const USER_TOKEN = process.env.USER_TOKEN;
const PORT = process.env.PORT || 3000;

// Создаем папку для временных файлов
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Создаем бота с polling (для разработки)
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true
});

// Состояния пользователей
const userStates = new Map();

// Функция для сброса состояния пользователя
function resetUserState(chatId) {
    userStates.set(chatId, { 
        waitingForUrl: true,
        firstStart: false
    });
}

// Функция для отправки приветственного сообщения
function sendWelcomeMessage(chatId, username, isFirstTime = true) {
    const welcomeText = isFirstTime 
        ? `👋 Привет, ${username}!
        
Я помогу получить список услуг из YClients.

📋 Что нужно сделать:
1. Отправьте мне ссылку на страницу компании YClients
   Например: https://n1960732.yclients.com/company/1726633/personal/menu?o=

2. Я извлеку ID компании и получу все услуги через API

3. Создам Excel файл с услугами и ценами

⏳ Ожидаю ссылку...`
        : `👋 С возвращением, ${username}!`;
    
    bot.sendMessage(chatId, welcomeText);
}

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name;
    
    // Проверяем, был ли уже старт у этого пользователя
    const userState = userStates.get(chatId);
    const isFirstTime = !userState || userState.firstStart === undefined;
    
    // Устанавливаем состояние "ожидание URL"
    resetUserState(chatId);
    userStates.get(chatId).firstStart = true;
    
    sendWelcomeMessage(chatId, username, isFirstTime);
});

// Команда /help
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    const helpText = `❓ Помощь
    
Как использовать бота:
1. Отправьте ссылку на компанию YClients
   Формат: https://...yclients.com/company/{ID}/...

Пример ссылки:
https://n1960732.yclients.com/company/1726633/personal/menu?o=

Что делает бот:
✅ Извлекает ID компании из ссылки
✅ Делает запрос к API YClients
✅ Получает список всех услуг
✅ Создает Excel файл с услугами и ценами
✅ Отправляет файл вам

Доступные команды:
/start - показать приветствие
/help - показать справку
/status - проверить состояние бота
/reset - сбросить состояние`;
    
    bot.sendMessage(chatId, helpText);
});

// Команда /status
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);
    
    let statusText = "📊 Статус: ";
    
    if (state?.waitingForUrl) {
        statusText += "⏳ Ожидаю ссылку от вас";
    } else if (state) {
        statusText += "✅ Готов к работе. Отправьте ссылку";
    } else {
        statusText += "🔄 Нажмите /start чтобы начать";
    }
    
    bot.sendMessage(chatId, statusText);
});

// Команда /reset
bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name;
    
    resetUserState(chatId);
    bot.sendMessage(chatId, `✅ Состояние сброшено, ${username}!\n\nТеперь я снова ожидаю ссылку на компанию YClients.`);
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const username = msg.from.username || msg.from.first_name;
    
    // Игнорируем команды
    if (!text || text.startsWith('/')) return;
    
    // Получаем состояние пользователя
    let userState = userStates.get(chatId);
    
    // Если у пользователя нет состояния (никогда не запускал /start)
    if (!userState) {
        // Автоматически создаем состояние и отправляем приветствие
        resetUserState(chatId);
        userStates.get(chatId).firstStart = false; // Не первичный старт
        
        sendWelcomeMessage(chatId, username, false);
        userState = userStates.get(chatId);
    }
    
    // Если пользователь ожидает URL
    if (userState?.waitingForUrl) {
        userStates.set(chatId, { ...userState, waitingForUrl: false });
        
        // Проверяем, является ли сообщение URL
        if (!isValidUrl(text)) {
            bot.sendMessage(chatId, "❌ Это не похоже на ссылку YClients. Пожалуйста, отправьте корректную ссылку.\n\nПример: https://n1960732.yclients.com/company/1726633/personal/menu?o=");
            
            // Возвращаем состояние "ожидание URL"
            userStates.set(chatId, { ...userState, waitingForUrl: true });
            return;
        }
        
        try {
            // Извлекаем ID компании
            const companyId = extractCompanyId(text);
            
            if (!companyId) {
                bot.sendMessage(chatId, "❌ Не удалось извлечь ID компании из ссылки. Проверьте формат ссылки.\n\nУбедитесь, что ссылка содержит \"/company/цифры/\"");
                
                // Возвращаем состояние "ожидание URL"
                userStates.set(chatId, { ...userState, waitingForUrl: true });
                return;
            }
            
            bot.sendMessage(chatId, `✅ ID компании найден: ${companyId}\n\n⏳ Получаю услуги...`);
            
            // Получаем услуги через API
            const services = await fetchServicesFromYclients(companyId);
            
            if (!services || services.length === 0) {
                bot.sendMessage(chatId, "❌ Не удалось получить услуги или список услуг пуст.\n\nПроверьте, что у компании есть услуги в YClients.");
                
                // Возвращаем состояние "ожидание URL"
                userStates.set(chatId, { ...userState, waitingForUrl: true });
                return;
            }
            
            bot.sendMessage(chatId, `✅ Получено услуг: ${services.length}\n\n⏳ Создаю Excel файл...`);
            
            // Создаем Excel файл
            const excelFilePath = await createExcelFile(services, companyId);
            
            // Отправляем файл
            await sendExcelFile(chatId, excelFilePath, companyId);
            
            // Удаляем временный файл
            try {
                fs.unlinkSync(excelFilePath);
                console.log(`Удален временный файл: ${excelFilePath}`);
            } catch (unlinkError) {
                console.error('Ошибка удаления временного файла:', unlinkError);
            }
            
            // После успешной обработки снова переводим в состояние ожидания URL
            userStates.set(chatId, { ...userState, waitingForUrl: true });
            
            // Предлагаем отправить новую ссылку
            setTimeout(() => {
                bot.sendMessage(chatId, `✅ Готово! Можете отправить еще одну ссылку или нажмите /help для справки.`);
            }, 1000);
            
        } catch (error) {
            console.error('Ошибка:', error);
            
            let errorMessage = "❌ Произошла ошибка при обработке запроса.";
            
            if (error.response) {
                errorMessage += `\n\nКод ошибки: ${error.response.status}`;
                if (error.response.data && error.response.data.meta) {
                    errorMessage += `\nСообщение: ${error.response.data.meta.message}`;
                }
            } else if (error.message) {
                errorMessage += `\n\n${error.message}`;
            }
            
            bot.sendMessage(chatId, errorMessage);
            
            // Возвращаем состояние "ожидание URL" даже при ошибке
            userStates.set(chatId, { ...userState, waitingForUrl: true });
        }
    } else {
        // Если бот не ожидает URL, но получил текст
        bot.sendMessage(chatId, `📝 Я ожидаю ссылку на компанию YClients.\n\nЕсли не знаете что делать, нажмите /help\nЧтобы начать заново, нажмите /reset`);
    }
});

// Функция для проверки URL
function isValidUrl(text) {
    try {
        const url = new URL(text);
        return url.hostname.includes('yclients.com');
    } catch {
        return false;
    }
}

// Функция для извлечения ID компании
function extractCompanyId(url) {
    try {
        // Ищем /company/{id}/ в URL
        const match = url.match(/\/company\/(\d+)\//);
        return match ? match[1] : null;
    } catch (error) {
        console.error('Ошибка извлечения ID компании:', error);
        return null;
    }
}

// Функция для получения услуг из YClients API
async function fetchServicesFromYclients(companyId) {
    const url = `https://api.yclients.com/api/v1/company/${companyId}/services`;
    
    const headers = {
        'Accept': 'application/vnd.yclients.v2+json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PARTNER_TOKEN}, User ${USER_TOKEN}`
    };
    
    console.log(`Запрос услуг с: ${url}`);
    
    try {
        const response = await axios.get(url, { headers, timeout: 10000 });
        
        if (response.data.success && response.data.data) {
            return response.data.data;
        } else {
            throw new Error('Ответ API указывает на ошибку');
        }
    } catch (error) {
        console.error('Ошибка получения услуг:', error.message);
        if (error.response) {
            console.error('Данные ответа:', error.response.data);
        }
        throw error;
    }
}

// Функция для создания Excel файла
async function createExcelFile(services, companyId) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Услуги');
    
    // Настраиваем заголовки
    worksheet.columns = [
        { header: 'ID услуги', key: 'id', width: 15 },
        { header: 'Услуга', key: 'title', width: 50 },
        { header: 'Минимальная цена (руб)', key: 'price_min', width: 25 },
        { header: 'Максимальная цена (руб)', key: 'price_max', width: 25 },
        { header: 'Минимальная цена 60% (руб)', key: 'price_min60', width: 25 },
        { header: 'Максимальная цена 60% (руб)', key: 'price_max60', width: 25 },
        { header: 'Минимальная цена 65% (руб)', key: 'price_min65', width: 25 },
        { header: 'Максимальная цена 65% (руб)', key: 'price_max65', width: 25 },
        { header: 'Минимальная цена 70% (руб)', key: 'price_min70', width: 25 },
        { header: 'Максимальная цена 70% (руб)', key: 'price_max70', width: 25 },
        { header: 'Минимальная цена 75% (руб)', key: 'price_min75', width: 25 },
        { header: 'Максимальная цена 75% (руб)', key: 'price_max75', width: 25 },
    ];
    
    // Стили для заголовков
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Добавляем данные
    services.forEach(service => {
        worksheet.addRow({
            id: service.id,
            title: service.title || 'Без названия',
            price_min: service.price_min || 0,
            price_max: service.price_max || service.price_min || 0,
            price_min60: Math.round(Number(service.price_min) * 0.6) || 0,
            price_max60: Math.round(Number(service.price_max) * 0.6) || Math.round(Number(service.price_min) * 0.6) || 0,
            price_min65: Math.round(Number(service.price_min) * 0.65) || 0,
            price_max65: Math.round(Number(service.price_max) * 0.65) || Math.round(Number(service.price_min) * 0.65) || 0,
            price_min70: Math.round(Number(service.price_min) * 0.70) || 0,
            price_max70: Math.round(Number(service.price_max) * 0.70) || Math.round(Number(service.price_min) * 0.70) || 0,
            price_min75: Math.round(Number(service.price_min) * 0.75) || 0,
            price_max75: Math.round(Number(service.price_max) * 0.75) || Math.round(Number(service.price_min) * 0.75) || 0,
        });
    });
    
    // Форматируем ячейки с ценами
    for (let i = 2; i <= services.length + 1; i++) {
        ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].forEach(col => {
            worksheet.getCell(`${col}${i}`).numFmt = '#,##0 ₽';
        });
    }
    
    // Добавляем итоговую строку
    const lastRow = services.length + 3;
    
    worksheet.getCell(`A${lastRow}`).value = 'ИТОГО УСЛУГ:';
    worksheet.getCell(`A${lastRow}`).font = { bold: true };
    
    worksheet.getCell(`B${lastRow}`).value = services.length;
    worksheet.getCell(`B${lastRow}`).font = { bold: true };
    
    // Добавляем статистику
    worksheet.getCell(`A${lastRow + 1}`).value = 'АКТИВНЫХ УСЛУГ:';
    worksheet.getCell(`A${lastRow + 1}`).font = { bold: true };
    
    const activeServices = services.filter(s => s.active === 1).length;
    worksheet.getCell(`B${lastRow + 1}`).value = activeServices;
    worksheet.getCell(`B${lastRow + 1}`).font = { bold: true };
    
    // Автофильтр
    worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: services.length + 1, column: worksheet.columns.length }
    };
    
    // Замораживаем верхнюю строку
    worksheet.views = [
        { state: 'frozen', xSplit: 0, ySplit: 1 }
    ];
    
    // Сохраняем файл
    const fileName = `services_${companyId}_${Date.now()}.xlsx`;
    const filePath = path.join(TEMP_DIR, fileName);
    
    await workbook.xlsx.writeFile(filePath);
    
    console.log(`Excel файл создан: ${filePath}`);
    return filePath;
}

// Функция для отправки Excel файла
async function sendExcelFile(chatId, filePath, companyId) {
    try {
        const stats = fs.statSync(filePath);
        const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        // Проверяем размер файла (Telegram ограничивает 50MB)
        if (stats.size > 50 * 1024 * 1024) {
            throw new Error(`Файл слишком большой: ${fileSizeInMB}MB (максимум 50MB)`);
        }
        
        const caption = `📊 Услуги компании #${companyId}

📁 Файл: services_${companyId}.xlsx
📏 Размер: ${fileSizeInMB} MB
📅 Создан: ${new Date().toLocaleString('ru-RU')}

✅ Файл готов к скачиванию!`;
        
        // Отправляем файл как поток (stream)
        const fileStream = fs.createReadStream(filePath);
        
        await bot.sendDocument(chatId, fileStream, {}, {
            filename: `services_${companyId}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }, {
            caption: caption
        });
        
        console.log(`Файл отправлен в чат ${chatId}`);
        
    } catch (error) {
        console.error('Ошибка отправки файла:', error);
        throw error;
    }
}

// Очистка старых временных файлов (раз в час)
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        const maxAge = 60 * 60 * 1000; // 1 час
        
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Очищен старый файл: ${file}`);
                }
            } catch (err) {
                console.error(`Ошибка проверки файла ${file}:`, err);
            }
        });
    } catch (error) {
        console.error('Ошибка очистки временных файлов:', error);
    }
}, 60 * 60 * 1000); // Каждый час

// Очистка старых состояний пользователей (раз в сутки)
setInterval(() => {
    const now = Date.now();
    const maxStateAge = 24 * 60 * 60 * 1000; // 24 часа
    console.log(`Текущее количество пользователей в памяти: ${userStates.size}`);
}, 24 * 60 * 60 * 1000); // Каждые 24 часа

// Обработка ошибок
bot.on('polling_error', (error) => {
    console.error('Ошибка polling:', error.code, error.message);
});

bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
});

// Обработка необработанных исключений
process.on('uncaughtException', (error) => {
    console.error('Неперехваченное исключение:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Неперехваченный промис на:', promise, 'причина:', reason);
});

// Запуск бота
console.log('🤖 Бот запущен и ожидает сообщений...');
console.log('📝 Пользователи могут сразу отправлять ссылки без /start');
console.log('📁 Временные файлы хранятся в:', TEMP_DIR);

// Для веб-версии (если нужно развернуть на хостинге)
if (process.env.NODE_ENV === 'production') {
    const express = require('express');
    const app = express();
    
    app.use(express.json());
    
    // Health check endpoint
    app.get('/', (req, res) => {
        res.json({ 
            status: 'online',
            bot: 'running',
            users: userStates.size,
            timestamp: new Date().toISOString()
        });
    });
    
    // Статистика
    app.get('/stats', (req, res) => {
        res.json({
            bot: 'YClint Services Bot',
            version: '1.0.0',
            activeUsers: userStates.size,
            uptime: process.uptime(),
            tempFiles: fs.readdirSync(TEMP_DIR).length,
            memory: process.memoryUsage()
        });
    });
    
    app.listen(PORT, () => {
        console.log(`🌐 Сервер запущен на порту ${PORT}`);
    });
}