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

// Лимиты API YClients
const API_LIMITS = {
    REQUESTS_PER_SECOND: 4, // 5 запросов в секунду, берем 4 для надежности
    REQUESTS_PER_MINUTE: 180, // 200 запросов в минуту, берем 180 для надежности
    DELAY_BETWEEN_REQUESTS: 250, // 250ms между запросами (4 запроса в секунду)
    BATCH_SIZE: 50, // Размер пачки для обработки
    TIMEOUT: 10000 // 10 секунд таймаут
};

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

// Кэш категорий для уменьшения запросов к API
const categoryCache = new Map();

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

3. Создам Excel файл с услугами, категориями и ценами

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
✅ Получает категории для каждой услуги
✅ Создает Excel файл с услугами, категориями и ценами
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
    
    // Добавляем статистику кэша
    statusText += `\n\n📦 Кэш категорий: ${categoryCache.size}`;
    
    bot.sendMessage(chatId, statusText);
});

// Команда /reset
bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name;
    
    resetUserState(chatId);
    bot.sendMessage(chatId, `✅ Состояние сброшено, ${username}!\n\nТеперь я снова ожидаю ссылку на компанию YClients.`);
});

// Команда для очистки кэша (для админов)
bot.onText(/\/clearcache/, (msg) => {
    const chatId = msg.chat.id;
    const cacheSize = categoryCache.size;
    
    categoryCache.clear();
    bot.sendMessage(chatId, `🧹 Кэш категорий очищен! Удалено ${cacheSize} записей.`);
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
            
            bot.sendMessage(chatId, `✅ Получено услуг: ${services.length}\n\n⏳ Получаю категории услуг...`);
            
            // Получаем категории для каждой услуги с учетом лимитов API
            const servicesWithCategories = await fetchCategoriesForServices(services, companyId, chatId);
            
            bot.sendMessage(chatId, `✅ Получено категорий: ${servicesWithCategories.filter(s => s.category_name).length}\n\n⏳ Создаю Excel файл...`);
            
            // Создаем Excel файл
            const excelFilePath = await createExcelFile(servicesWithCategories, companyId);
            
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
        const response = await axios.get(url, { headers, timeout: API_LIMITS.TIMEOUT });
        
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

// Функция для получения категорий услуг с учетом лимитов API
async function fetchCategoriesForServices(services, companyId, chatId) {
    const servicesWithCategories = [...services];
    const uniqueCategoryIds = new Set();
    
    // Собираем уникальные category_id
    services.forEach(service => {
        if (service.category_id) {
            uniqueCategoryIds.add(service.category_id);
        }
    });
    
    console.log(`Всего уникальных категорий для получения: ${uniqueCategoryIds.size}`);
    
    // Отправляем сообщение о начале загрузки категорий
    if (chatId && uniqueCategoryIds.size > 0) {
        await bot.sendMessage(chatId, `📥 Получаю ${uniqueCategoryIds.size} категорий...\n⏳ Это может занять некоторое время.`);
    } else if (chatId) {
        await bot.sendMessage(chatId, `✅ Нет категорий для получения.`);
        // Добавляем категории к услугам
        servicesWithCategories.forEach(service => {
            service.category_name = 'Без категории';
        });
        return servicesWithCategories;
    }
    
    // Получаем категории пачками с задержками
    const categoryIdsArray = Array.from(uniqueCategoryIds);
    const categories = new Map();
    
    // Разбиваем на пачки
    const batches = [];
    for (let i = 0; i < categoryIdsArray.length; i += API_LIMITS.BATCH_SIZE) {
        batches.push(categoryIdsArray.slice(i, i + API_LIMITS.BATCH_SIZE));
    }
    
    console.log(`Разбито на ${batches.length} пачек по ${API_LIMITS.BATCH_SIZE} категорий`);
    
    // Обрабатываем каждую пачку
    let processedCount = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        // Создаем промисы для текущей пачки
        const promises = batch.map((categoryId, index) => {
            // Задержка между запросами в пачке
            const delay = index * API_LIMITS.DELAY_BETWEEN_REQUESTS;
            
            return new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        const categoryName = await fetchCategoryById(companyId, categoryId);
                        resolve({ categoryId, categoryName });
                    } catch (error) {
                        console.error(`Ошибка получения категории ${categoryId}:`, error.message);
                        resolve({ categoryId, categoryName: null });
                    }
                }, delay);
            });
        });
        
        // Ждем выполнения текущей пачки
        const batchResults = await Promise.all(promises);
        
        // Сохраняем результаты
        batchResults.forEach(result => {
            categories.set(result.categoryId, result.categoryName);
        });
        
        processedCount += batch.length;
        
        // Отправляем прогресс каждые 20% или каждые 50 категорий
        if (chatId && (processedCount % 50 === 0 || batchIndex === batches.length - 1)) {
            const percent = Math.round((processedCount / uniqueCategoryIds.size) * 100);
            try {
                await bot.sendMessage(chatId, `📊 Прогресс: ${percent}% (${processedCount}/${uniqueCategoryIds.size})`);
            } catch (error) {
                console.error('Ошибка отправки прогресса:', error.message);
            }
        }
        
        // Задержка между пачками (1 секунда для надежности)
        if (batchIndex < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Добавляем категории к услугам
    servicesWithCategories.forEach(service => {
        if (service.category_id && categories.has(service.category_id)) {
            service.category_name = categories.get(service.category_id);
        } else {
            service.category_name = 'Без категории';
        }
    });
    
    return servicesWithCategories;
}

// Функция для получения категории по ID с кэшированием
async function fetchCategoryById(companyId, categoryId) {
    // Проверяем кэш
    const cacheKey = `${companyId}_${categoryId}`;
    if (categoryCache.has(cacheKey)) {
        return categoryCache.get(cacheKey);
    }
    const url = `https://api.yclients.com/api/v1/service_category/${companyId}/${categoryId}`;
    
    const headers = {
        'Accept': 'application/vnd.yclients.v2+json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PARTNER_TOKEN}`
    };
    
    try {
        const response = await axios.get(url, { 
            headers, 
            timeout: API_LIMITS.TIMEOUT 
        });
        
        if (response.data.success && response.data.data) {
            const categoryName = response.data.data.title || 'Без названия';
            // Сохраняем в кэш
            categoryCache.set(cacheKey, categoryName);
            
            // Ограничиваем размер кэша
            if (categoryCache.size > 1000) {
                const firstKey = categoryCache.keys().next().value;
                categoryCache.delete(firstKey);
            }
            
            return categoryName;
        } else {
            throw new Error('Ответ API указывает на ошибку');
        }
    } catch (error) {
        // Если ошибка 404 (категория не найдена), возвращаем значение по умолчанию
        if (error.response && error.response.status === 404) {
            const defaultName = 'Категория не найдена';
            categoryCache.set(cacheKey, defaultName);
            return defaultName;
        }
        
        console.error(`Ошибка получения категории ${categoryId} для компании ${companyId}:`, error.message);
        throw error;
    }
}

// Функция для создания Excel файла
async function createExcelFile(services, companyId) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Услуги');
    
    // Настраиваем заголовки (добавили колонку "Категория" на второе место)
    worksheet.columns = [
        { header: 'ID услуги', key: 'id', width: 15 },
        { header: 'Категория', key: 'category', width: 30 },
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
            category: service.category_name || 'Без категории',
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
    
    // Форматируем ячейки с ценами (теперь с D по M, т.к. добавили колонку "Категория")
    for (let i = 2; i <= services.length + 1; i++) {
        ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'].forEach(col => {
            worksheet.getCell(`${col}${i}`).numFmt = '#,##0 ₽';
        });
    }
    
    // Добавляем группировку по категориям
    const categories = [...new Set(services.map(s => s.category_name || 'Без категории'))];
    
    // Добавляем итоговую строку
    const lastRow = services.length + 3;
    
    worksheet.getCell(`A${lastRow}`).value = 'ИТОГО УСЛУГ:';
    worksheet.getCell(`A${lastRow}`).font = { bold: true };
    
    worksheet.getCell(`C${lastRow}`).value = services.length;
    worksheet.getCell(`C${lastRow}`).font = { bold: true };
    
    // Добавляем статистику по категориям
    let categoryRow = lastRow + 2;
    worksheet.getCell(`A${categoryRow}`).value = 'СТАТИСТИКА ПО КАТЕГОРИЯМ:';
    worksheet.getCell(`A${categoryRow}`).font = { bold: true };
    
    categories.forEach(category => {
        categoryRow++;
        const servicesInCategory = services.filter(s => (s.category_name || 'Без категории') === category).length;
        worksheet.getCell(`A${categoryRow}`).value = category;
        worksheet.getCell(`B${categoryRow}`).value = servicesInCategory;
        
        // Выделяем категории цветом
        if (category === 'Без категории') {
            worksheet.getCell(`A${categoryRow}`).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFCCCC' }
            };
        }
    });
    
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
        
        // Читаем файл в Buffer
        const fileBuffer = fs.readFileSync(filePath);
        
        // Отправляем файл как Buffer
        await bot.sendDocument(chatId, fileBuffer, {
            filename: `services_${companyId}.xlsx`,
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
    console.log(`📊 Статистика:
    Пользователей в памяти: ${userStates.size}
    Категорий в кэше: ${categoryCache.size}`);
}, 24 * 60 * 60 * 1000); // Каждые 24 часа

// Очистка кэша категорий (раз в 6 часов)
setInterval(() => {
    const cacheSize = categoryCache.size;
    if (cacheSize > 500) {
        // Очищаем половину кэша
        const keysToDelete = Array.from(categoryCache.keys()).slice(0, Math.floor(cacheSize / 2));
        keysToDelete.forEach(key => categoryCache.delete(key));
        console.log(`🧹 Очищена половина кэша категорий. Было: ${cacheSize}, стало: ${categoryCache.size}`);
    }
}, 6 * 60 * 60 * 1000); // Каждые 6 часов

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
console.log('⚡ Лимиты API настроены:');
console.log(`   • ${API_LIMITS.REQUESTS_PER_SECOND} запросов в секунду`);
console.log(`   • ${API_LIMITS.REQUESTS_PER_MINUTE} запросов в минуту`);
console.log(`   • Задержка между запросами: ${API_LIMITS.DELAY_BETWEEN_REQUESTS}ms`);

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
            categoriesCache: categoryCache.size,
            timestamp: new Date().toISOString()
        });
    });
    
    // Статистика
    app.get('/stats', (req, res) => {
        res.json({
            bot: 'YClint Services Bot',
            version: '1.0.0',
            activeUsers: userStates.size,
            categoriesCache: categoryCache.size,
            uptime: process.uptime(),
            tempFiles: fs.readdirSync(TEMP_DIR).length,
            memory: process.memoryUsage(),
            apiLimits: API_LIMITS
        });
    });
    
    // Очистка кэша
    app.get('/clearcache', (req, res) => {
        const cacheSize = categoryCache.size;
        categoryCache.clear();
        res.json({
            success: true,
            message: `Кэш очищен. Удалено ${cacheSize} записей.`
        });
    });
    
    app.listen(PORT, () => {
        console.log(`🌐 Сервер запущен на порту ${PORT}`);
    });
}