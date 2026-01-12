// ==UserScript==
// @name         Opinion.trade 自动交易脚本 (API版本)
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自动化 Opinion.trade 交易流程,优先使用API获取持仓
// @author       Your Name
// @match        https://app.opinion.trade/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @icon         https://app.opinion.trade/favicon.ico
// @license      MIT
// @run-at       document-end
// @connect      proxy.opinion.trade
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 常量定义 ====================
    const CONSTANTS = {
        MIN_POSITION_VALUE: 1,        // 最小持仓市值(美元)
        API_TIMEOUT: 10000,           // API请求超时时间(毫秒)
        WALLET_ADDRESS_LENGTH: 42,    // 完整钱包地址长度
        POSITION_CHECK_INTERVAL: 1000,// 持仓检查间隔(毫秒)
        POSITION_CHECK_MAX_ATTEMPTS: 30,// 持仓检查最大尝试次数
        DOM_WAIT_TIME: 2000,         // DOM等待时间(毫秒)
        MAKER_ORDER_CHECK_INTERVAL: 1000, // Maker 订单检查间隔(毫秒)
        MAKER_MAX_WAIT_TIME: 60000,  // Maker 最大等待成交时间(毫秒)
        MAKER_RETRY_TIMES: 3         // Maker 挂单重试次数
    };

    // ==================== 配置管理 ====================
    const DEFAULT_CONFIG = {
        marketUrl: 'https://app.opinion.trade/detail?topicId=61&type=multi',
        optionName: 'No change',
        tradeAmount: 10,
        holdTime: 60,
        tradeType: 'YES',
        autoStart: false,
        waitBeforeTrade: 2,
        retryAttempts: 3,
        enableLog: true,
        sellWaitTime: 5,
        useApiFirst: true,  // 是否优先使用API获取持仓
        tradeMode: 'taker',  // 交易模式: 'taker' 或 'maker'
        makerWaitTime: 5     // Maker 检测成交间隔(秒)
    };

    const Config = {
        get: (key) => {
            const value = GM_getValue(key, DEFAULT_CONFIG[key]);
            return value;
        },
        set: (key, value) => {
            GM_setValue(key, value);
        },
        getAll: () => {
            const config = {};
            for (const key in DEFAULT_CONFIG) {
                config[key] = GM_getValue(key, DEFAULT_CONFIG[key]);
            }
            return config;
        },
        setAll: (values) => {
            for (const key in values) {
                GM_setValue(key, values[key]);
            }
        },
        reset: () => {
            for (const key in DEFAULT_CONFIG) {
                GM_setValue(key, DEFAULT_CONFIG[key]);
            }
        }
    };

    // ==================== 日志函数 ====================
    const log = (message, type = 'info') => {
        if (!Config.get('enableLog')) return;
        const prefix = '[Opinion Auto Trader]';
        const colors = {
            info: '#00bfff',
            success: '#00ff00',
            error: '#ff4444',
            warn: '#ffaa00'
        };
        console.log(`%c${prefix}`, `color: ${colors[type]}; font-weight: bold`, message);
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const waitForElement = (selector, timeout = 10000) => {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver((mutations, obs) => {
                const element = document.querySelector(selector);
                if (element) {
                    obs.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`元素未找到: ${selector}`));
            }, timeout);
        });
    };

    // ==================== API 请求方法 ====================

    /**
     * 从页面获取钱包地址
     * @returns {string|null} 钱包地址
     */
    async function getWalletAddress() {
        try {
            log('正在获取钱包地址...', 'info');

            // 方法1: 从页面中查找显示的钱包地址
            const walletSelectors = [
                // 查找包含钱包地址的元素(通常是截断显示的)
                'span[class*="address"]',
                'div[class*="wallet"] span',
                '[class*="connect"] span',
                'button[class*="wallet"] span'
            ];

            for (const selector of walletSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    const text = el.textContent.trim();
                    // 钱包地址通常是 0x 开头的42位字符(可能被截断显示为 0x1234...abcd)
                    if (text.match(/^0x[a-fA-F0-9]{4,40}$/)) {
                        // 只有42位完整地址才使用,截断地址继续查找
                        if (text.length === CONSTANTS.WALLET_ADDRESS_LENGTH) {
                            log(`从DOM找到完整钱包地址: ${text.slice(0, 6)}...${text.slice(-4)}`, 'success');
                            return text;
                        } else {
                            log(`找到截断地址: ${text},继续查找完整地址`, 'info');
                        }
                    }
                }
            }

            // 方法2: 从 localStorage 或 sessionStorage 获取
            const storageKeys = ['walletAddress', 'userAddress', 'account', 'wallet'];
            for (const key of storageKeys) {
                const value = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (value && value.length === CONSTANTS.WALLET_ADDRESS_LENGTH && value.match(/^0x[a-fA-F0-9]+$/)) {
                    log(`从存储找到钱包地址: ${value.slice(0, 6)}...${value.slice(-4)}`, 'success');
                    return value;
                }
            }

            // 方法3: 尝试从 window 对象获取(某些网站会将钱包信息挂载到 window)
            if (window.ethereum && window.ethereum.selectedAddress) {
                const addr = window.ethereum.selectedAddress;
                log(`从 ethereum.selectedAddress 找到: ${addr.slice(0, 6)}...${addr.slice(-4)}`, 'success');
                return addr;
            }

            log('⚠️ 未能自动获取钱包地址', 'warn');
            return null;

        } catch (error) {
            log(`获取钱包地址失败: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * 从 API 获取持仓信息
     * @param {string} walletAddress - 钱包地址
     * @returns {Promise<Object|null>} 持仓数据或null
     */
    async function fetchPositionsFromAPI(walletAddress) {
        return new Promise((resolve) => {
            if (!walletAddress) {
                log('⚠️ 钱包地址为空,跳过API请求', 'warn');
                resolve(null);
                return;
            }

            // 从当前URL获取parentTopicId
            const urlParams = new URLSearchParams(window.location.search);
            const parentTopicId = urlParams.get('topicId') || '61';

            const apiUrl = `https://proxy.opinion.trade:8443/api/bsc/api/v2/portfolio?page=1&limit=100&walletAddress=${walletAddress}&parentTopicId=${parentTopicId}`;

            log(`正在请求API: ${apiUrl}`, 'info');

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                onload: function(response) {
                    try {
                        log(`API响应状态: ${response.status}`, 'info');

                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);

                            if (data.errno === 0 && data.result) {
                                // 验证数据结构
                                if (typeof data.result !== 'object') {
                                    log('API返回数据格式异常: result不是对象', 'warn');
                                    resolve(null);
                                    return;
                                }

                                if (!Array.isArray(data.result.list)) {
                                    log('API返回数据格式异常: list字段不是数组', 'warn');
                                    resolve(null);
                                    return;
                                }

                                log('✅ API请求成功', 'success');
                                log(`返回持仓数量: ${data.result.list.length}`, 'info');
                                resolve(data.result);
                            } else {
                                log(`API返回错误: ${data.errmsg || '未知错误'} (errno: ${data.errno})`, 'warn');
                                resolve(null);
                            }
                        } else {
                            log(`API请求失败,状态码: ${response.status}`, 'warn');
                            resolve(null);
                        }
                    } catch (error) {
                        log(`解析API响应失败: ${error.message}`, 'error');
                        // 记录响应内容的前200字符用于调试
                        if (response.responseText) {
                            const preview = response.responseText.substring(0, 200);
                            log(`响应内容预览: ${preview}${response.responseText.length > 200 ? '...' : ''}`, 'error');
                        }
                        resolve(null);
                    }
                },
                onerror: function(error) {
                    const timestamp = new Date().toISOString();
                    log(`API网络请求失败: ${timestamp}`, 'error');
                    log(`请求URL: ${apiUrl}`, 'error');
                    resolve(null);
                },
                ontimeout: function() {
                    log('API请求超时', 'warn');
                    resolve(null);
                },
                timeout: CONSTANTS.API_TIMEOUT
            });
        });
    }

    /**
     * 解析API持仓数据,判断是否有有效持仓
     * @param {Object} apiResult - API返回的result对象
     * @returns {boolean} 是否有有效持仓
     */
    function parseAPIPositions(apiResult) {
        if (!apiResult || !apiResult.list || !Array.isArray(apiResult.list)) {
            return false;
        }

        log(`API返回 ${apiResult.list.length} 个持仓记录`, 'info');

        // 过滤有效持仓(市值 > MIN_POSITION_VALUE)
        const validPositions = apiResult.list.filter(position => {
            const value = parseFloat(position.value || 0);
            const logValid = value > CONSTANTS.MIN_POSITION_VALUE;
            if (logValid) {
                log(`有效持仓: ${position.topicTitle} - ${position.outcome}, 市值: $${value}`, 'info');
            }
            return logValid;
        });

        if (validPositions.length > 0) {
            log(`✅ API检测到 ${validPositions.length} 个有效持仓(市值>$${CONSTANTS.MIN_POSITION_VALUE})`, 'success');
            return true;
        } else {
            log(`✅ API显示无有效持仓或市值≤$${CONSTANTS.MIN_POSITION_VALUE}`, 'success');
            return false;
        }
    }

    // ==================== DOM 查询方法(备用方案) ====================

    /**
     * 从DOM获取持仓信息(原有方法)
     * @returns {Promise<boolean>} 是否有有效持仓
     */
    async function checkPositionsFromDOM() {
        log('🔄 降级到DOM方案获取持仓...', 'info');

        // 等待持仓页面加载
        await sleep(CONSTANTS.DOM_WAIT_TIME);

        // 查找持仓表格
        const positionRows = Array.from(document.querySelectorAll('tbody tr'));

        // 过滤掉空行且持仓市值>1
        const hasPositions = positionRows.some(row => {
            const cells = Array.from(row.querySelectorAll('td'));

            // 检查行是否有足够的列
            if (cells.length < 3) return false;

            // 检查是否包含持仓特征
            const outcomeText = cells[0].textContent.trim();
            const hasSellButton = row.textContent.includes('Sell');
            const isValidPosition = (outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton;

            if (!isValidPosition) return false;

            // Market Value 在第3列(索引2)
            const marketValueCell = cells[2];
            const marketValueText = marketValueCell.textContent.trim();

            // 提取市值数字
            const marketValueMatch = marketValueText.match(/\$?([\d,]+\.?\d*)/);
            if (marketValueMatch) {
                const marketValue = parseFloat(marketValueMatch[1].replace(/,/g, ''));
                log(`DOM检测持仓市值: ${marketValueText}`, 'info');

                if (!isNaN(marketValue) && marketValue > CONSTANTS.MIN_POSITION_VALUE) {
                    log(`✅ DOM检测到有效持仓(市值: $${marketValue})`, 'info');
                    return true;
                }
            }

            return false;
        });

        if (hasPositions) {
            log('✅ DOM方案检测到现有持仓', 'success');
        } else {
            log('✅ DOM方案显示无有效持仓', 'success');
        }

        return hasPositions;
    }

    // ==================== Maker 模式 API 方法 ====================

    /**
     * 从当前 URL 获取 topicId
     * @returns {string|null} topicId
     */
    function getTopicIdFromURL() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const topicId = urlParams.get('topicId');
            if (topicId) {
                log(`从 URL 获取 topicId: ${topicId}`, 'success');
                return topicId;
            }
            log('⚠️ URL 中未找到 topicId', 'warn');
            return null;
        } catch (error) {
            log(`获取 topicId 失败: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * 根据 title 获取市场信息 (questionId, yesPos, noPos)
     * @param {string} title - 选项标题,如 "No change"
     * @returns {Promise<Object|null>} 市场信息对象
     */
    async function fetchMarketInfoByTitle(title) {
        return new Promise((resolve) => {
            const topicId = getTopicIdFromURL();
            if (!topicId) {
                log('⚠️ 无法获取 topicId,跳过市场信息获取', 'warn');
                resolve(null);
                return;
            }

            const apiUrl = `https://proxy.opinion.trade:8443/api/bsc/api/v2/topic/mutil/${topicId}`;

            log(`正在获取市场信息: ${apiUrl}`, 'info');
            log(`查找标题: ${title}`, 'info');

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                onload: function(response) {
                    try {
                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);

                            if (data.errno === 0 && data.result && data.result.data && data.result.data.childList) {
                                const childList = data.result.data.childList;

                                // 遍历 childList 查找匹配的 title
                                const matched = childList.find(child => {
                                    const childTitle = child.title || child.titleShort || '';
                                    return childTitle === title || childTitle.includes(title);
                                });

                                if (matched) {
                                    const marketInfo = {
                                        questionId: matched.questionId,
                                        yesPos: matched.yesPos,
                                        noPos: matched.noPos,
                                        yesMarketPrice: matched.yesMarketPrice,
                                        noMarketPrice: matched.noMarketPrice,
                                        title: matched.title,
                                        topicId: topicId
                                    };

                                    log('✅ 找到匹配的市场信息', 'success');
                                    log(`  questionId: ${marketInfo.questionId}`, 'info');
                                    log(`  yesPos: ${marketInfo.yesPos}`, 'info');
                                    log(`  noPos: ${marketInfo.noPos}`, 'info');
                                    log(`  YES 价格: ${marketInfo.yesMarketPrice}`, 'info');
                                    log(`  NO 价格: ${marketInfo.noMarketPrice}`, 'info');

                                    resolve(marketInfo);
                                } else {
                                    log(`⚠️ 未找到标题匹配 "${title}" 的市场`, 'warn');
                                    log(`可用标题: ${childList.map(c => c.title).join(', ')}`, 'info');
                                    resolve(null);
                                }
                            } else {
                                log(`API返回错误: ${data.errmsg || '未知错误'}`, 'warn');
                                resolve(null);
                            }
                        } else {
                            log(`API请求失败,状态码: ${response.status}`, 'warn');
                            resolve(null);
                        }
                    } catch (error) {
                        log(`解析市场信息失败: ${error.message}`, 'error');
                        resolve(null);
                    }
                },
                onerror: function(error) {
                    log(`获取市场信息网络请求失败`, 'error');
                    resolve(null);
                },
                ontimeout: function() {
                    log('获取市场信息请求超时', 'warn');
                    resolve(null);
                },
                timeout: CONSTANTS.API_TIMEOUT
            });
        });
    }

    /**
     * 获取订单簿深度
     * @param {string} symbol - token symbol (yesPos)
     * @param {string} questionId - 问题 ID
     * @returns {Promise<Object|null>} 深度数据 { asks: [], bids: [] }
     */
    async function fetchOrderDepth(symbol, questionId) {
        return new Promise((resolve) => {
            const apiUrl = `https://proxy.opinion.trade:8443/api/bsc/api/v2/order/market/depth?symbol=${symbol}&chainId=56&question_id=${questionId}&symbol_types=0`;

            log(`正在获取订单簿深度...`, 'info');

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                onload: function(response) {
                    try {
                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);

                            if (data.errno === 0 && data.result) {
                                const asks = data.result.asks || [];
                                const bids = data.result.bids || [];

                                if (asks.length > 0 && bids.length > 0) {
                                    const ask1 = asks[0]; // 最低卖价
                                    const bid1 = bids[0]; // 最高买价

                                    log('✅ 获取订单簿深度成功', 'success');
                                    log(`  ask1 (最低卖价): ${ask1[0]} (数量: ${ask1[1]})`, 'info');
                                    log(`  bid1 (最高买价): ${bid1[0]} (数量: ${bid1[1]})`, 'info');
                                    log(`  价差: ${((ask1[0] - bid1[0]) / bid1[0] * 100).toFixed(4)}%`, 'info');

                                    resolve({
                                        asks: asks,
                                        bids: bids,
                                        ask1: {
                                            price: parseFloat(ask1[0]),
                                            amount: parseFloat(ask1[1])
                                        },
                                        bid1: {
                                            price: parseFloat(bid1[0]),
                                            amount: parseFloat(bid1[1])
                                        }
                                    });
                                } else {
                                    log('⚠️ 订单簿深度数据为空', 'warn');
                                    resolve(null);
                                }
                            } else {
                                log(`API返回错误: ${data.errmsg || '未知错误'}`, 'warn');
                                resolve(null);
                            }
                        } else {
                            log(`API请求失败,状态码: ${response.status}`, 'warn');
                            resolve(null);
                        }
                    } catch (error) {
                        log(`解析订单簿深度失败: ${error.message}`, 'error');
                        resolve(null);
                    }
                },
                onerror: function(error) {
                    log(`获取订单簿深度网络请求失败`, 'error');
                    resolve(null);
                },
                ontimeout: function() {
                    log('获取订单簿深度请求超时', 'warn');
                    resolve(null);
                },
                timeout: CONSTANTS.API_TIMEOUT
            });
        });
    }

    /**
     * 查询当前订单
     * @param {string} walletAddress - 钱包地址
     * @param {string} parentTopicId - 父主题ID
     * @returns {Promise<Object|null>} 订单列表
     */
    async function fetchCurrentOrders(walletAddress, parentTopicId) {
        return new Promise((resolve) => {
            const apiUrl = `https://proxy.opinion.trade:8443/api/bsc/api/v2/order?page=1&limit=10&walletAddress=${walletAddress}&parentTopicId=${parentTopicId}&queryType=1`;

            log(`正在查询当前订单...`, 'info');

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                onload: function(response) {
                    try {
                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);

                            if (data.errno === 0 && data.result && data.result.list) {
                                const orders = data.result.list;
                                log(`✅ 查询到 ${orders.length} 个订单`, 'success');

                                orders.forEach(order => {
                                    log(`  订单ID: ${order.orderId}, transNo: ${order.transNo}`, 'info');
                                    log(`    主题: ${order.topicTitle}, 方向: ${order.side === 1 ? '买入' : '卖出'}`, 'info');
                                    log(`    价格: ${order.price}, 数量: ${order.amount}`, 'info');
                                    log(`    成交: ${order.filled}, 状态: ${order.status}`, 'info');
                                });

                                resolve(orders);
                            } else {
                                log(`API返回错误: ${data.errmsg || '未知错误'}`, 'warn');
                                resolve(null);
                            }
                        } else {
                            log(`API请求失败,状态码: ${response.status}`, 'warn');
                            resolve(null);
                        }
                    } catch (error) {
                        log(`解析订单数据失败: ${error.message}`, 'error');
                        resolve(null);
                    }
                },
                onerror: function(error) {
                    log(`查询订单网络请求失败`, 'error');
                    resolve(null);
                },
                ontimeout: function() {
                    log('查询订单请求超时', 'warn');
                    resolve(null);
                },
                timeout: CONSTANTS.API_TIMEOUT
            });
        });
    }

    /**
     * 撤销订单
     * @param {string} transNo - 订单交易号
     * @param {number} chainId - 链ID (默认56为BSC)
     * @returns {Promise<boolean>} 是否成功
     */
    async function cancelOrder(transNo, chainId = 56) {
        return new Promise((resolve) => {
            const apiUrl = 'https://proxy.opinion.trade:8443/api/bsc/api/v1/order/cancel/order';

            log(`正在撤销订单: ${transNo}`, 'info');

            GM_xmlhttpRequest({
                method: 'POST',
                url: apiUrl,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify({
                    trans_no: transNo,
                    chainId: chainId
                }),
                onload: function(response) {
                    try {
                        if (response.status === 200) {
                            const data = JSON.parse(response.responseText);

                            if (data.errno === 0) {
                                log(`✅ 订单撤销成功: ${transNo}`, 'success');
                                resolve(true);
                            } else {
                                log(`订单撤销失败: ${data.errmsg || '未知错误'}`, 'warn');
                                resolve(false);
                            }
                        } else {
                            log(`订单撤销请求失败,状态码: ${response.status}`, 'warn');
                            resolve(false);
                        }
                    } catch (error) {
                        log(`解析撤单响应失败: ${error.message}`, 'error');
                        resolve(false);
                    }
                },
                onerror: function(error) {
                    log(`撤销订单网络请求失败`, 'error');
                    resolve(false);
                },
                ontimeout: function() {
                    log('撤销订单请求超时', 'warn');
                    resolve(false);
                },
                timeout: CONSTANTS.API_TIMEOUT
            });
        });
    }

    // ==================== 核心交易逻辑 ====================
    let currentTrader = null;

    /**
     * Maker 模式交易类
     * 实现同时在 ask1/bid1 挂单,一边成交后撤另一边并卖出的策略
     */
    class MakerTrader {
        constructor() {
            this.config = Config.getAll();
            this.isRunning = false;
            this.shouldStop = false;
            this.marketInfo = null;  // { questionId, yesPos, noPos }
            this.depthData = null;   // { asks, bids, ask1, bid1 }
            this.pendingOrders = {   // 待成交订单
                buy: null,   //买单订单信息
                sell: null   //卖单订单信息
            };
            this.filledOrder = null; // 已成交订单 { side, price, amount }
        }

        /**
         * 初始化市场信息
         */
        async initMarketInfo() {
            log('📊 正在初始化市场信息...', 'info');

            const marketInfo = await fetchMarketInfoByTitle(this.config.optionName);

            if (!marketInfo) {
                throw new Error('无法获取市场信息,请检查 optionName 配置');
            }

            this.marketInfo = marketInfo;
            return marketInfo;
        }

        /**
         * 获取订单簿深度
         */
        async fetchDepth() {
            if (!this.marketInfo) {
                throw new Error('市场信息未初始化');
            }

            const depth = await fetchOrderDepth(this.marketInfo.yesPos, this.marketInfo.questionId);

            if (!depth) {
                throw new Error('无法获取订单簿深度');
            }

            this.depthData = depth;
            return depth;
        }

        /**
         * 同时在 ask1 和 bid1 挂单 (使用 DOM 操作实现限价单)
         */
        async placeBothOrders() {
            log('🔄 准备同时挂买卖单 (限价单模式)...', 'info');

            if (!this.depthData) {
                throw new Error('订单簿深度未获取');
            }

            const ask1Price = this.depthData.ask1.price;
            const bid1Price = this.depthData.bid1.price;

            log(`目标价格:`, 'info');
            log(`  ask1 (最低卖价): ${ask1Price}`, 'info');
            log(`  bid1 (最高买价): ${bid1Price}`, 'info');
            log(`  当前市价 YES: ${this.marketInfo.yesMarketPrice}`, 'info');

            // 检查当前是否在 Buy tab
            const buyTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                const text = tab.textContent.trim();
                return text === 'Buy';
            });

            const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                const text = tab.textContent.trim();
                return text === 'Sell';
            });

            // 如果不在 Buy tab,切换过去
            if (sellTab && sellTab.hasAttribute('data-selected')) {
                log('切换到 Buy tab 准备挂买单...', 'info');
                if (buyTab) {
                    buyTab.click();
                    await sleep(1000);
                }
            }

            // === 步骤 1: 选择选项 ===
            log('步骤 1/5: 选择选项...', 'info');
            const optionButton = await this.findOptionButton(this.config.optionName);
            if (!optionButton) {
                throw new Error(`未找到选项: ${this.config.optionName}`);
            }
            optionButton.click();
            await sleep(1000);

            // === 步骤 2: 点击 YES 按钮 (准备买) ===
            log('步骤 2/5: 点击 YES 按钮准备买入...', 'info');
            const yesButton = await this.findTradeButton('YES');
            yesButton.click();
            await sleep(1000);

            // === 步骤 3: 输入限价单价格 ===
            log('步骤 3/5: 输入限价单价格...', 'info');

            // 使用 ask1 价格作为买入限价 (稍微高一点点确保成交)
            const limitPrice = ask1Price;
            await this.inputPrice(limitPrice);

            // === 步骤 4: 输入金额 ===
            log('步骤 4/5: 输入下单金额...', 'info');
            await this.inputAmount(this.config.tradeAmount);

            // 等待一下确保输入生效
            await sleep(1000);

            // === 步骤 5: 点击买入按钮 ===
            log('步骤 5/5: 点击买入按钮...', 'info');
            const buyButton = await this.findBuyButton();
            buyButton.click();

            log('⏳ 请在MetaMask钱包中确认买入交易...', 'warn');

            // 等待交易确认
            let buyConfirmed = await this.waitForTransactionConfirmation('买入');

            if (!buyConfirmed) {
                throw new Error('买入交易未能在预期时间内确认');
            }

            log('✅ 限价买单已提交', 'success');

            // 等待持仓出现
            log('⏳ 等待持仓确认...', 'info');
            let positionsAppeared = false;
            for (let i = 0; i < 30; i++) {
                if (this.shouldStop) throw new Error('用户手动停止');

                const hasPositionsNow = await this.checkPositions();

                if (hasPositionsNow) {
                    log('✅ 持仓已确认', 'success');
                    positionsAppeared = true;
                    break;
                }

                await sleep(1000);
                if (i % 5 === 0 && i > 0) {
                    log(`⏳ 继续等待持仓出现... (${30-i}秒剩余)`, 'info');
                }
            }

            if (!positionsAppeared) {
                log('⚠️ 30秒内未检测到持仓出现,但继续执行', 'warn');
            }

            log('✅ 限价单挂单流程完成', 'success');
        }

        /**
         * 查找价格输入框
         */
        async findPriceInput() {
            log('正在查找价格输入框', 'info');

            // 价格输入框可能和金额输入框不同
            // 尝试多种选择器
            const selectors = [
                'input[placeholder*="price" i]',
                'input[placeholder*="Price" i]',
                'input[placeholder*="¢"]',
                'input[placeholder*="cents" i]',
                'input[type="number"]',
            ];

            for (const selector of selectors) {
                const inputs = Array.from(document.querySelectorAll(selector));
                for (const input of inputs) {
                    // 检查是否可见
                    const rect = input.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        // 检查是否不是金额输入框(金额输入框通常placeholder是0)
                        if (input.placeholder !== '0') {
                            log(`找到价格输入框 (selector: ${selector})`, 'success');
                            return input;
                        }
                    }
                }
            }

            // 如果没找到,尝试查找所有文本输入框
            const allTextInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
            for (const input of allTextInputs) {
                const rect = input.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && input.placeholder !== '0') {
                    log(`找到可能的 price 输入框`, 'info');
                    return input;
                }
            }

            throw new Error('未找到价格输入框');
        }

        /**
         * 输入限价单价格
         * @param {number} price - 价格值 (小数形式,如 0.044,需要转换为4.4)
         */
        async inputPrice(price) {
            // 将小数价格转换为 cents 格式 (乘以100)
            // 0.044 -> 4.4
            // 不使用 Math.round(),而是保留一位小数
            const priceInCents = parseFloat((price * 100).toFixed(1));

            log(`准备输入价格: ${price} (转换为 ${priceInCents}¢)`, 'info');

            const priceInput = await this.findPriceInput();

            // 调试: 记录输入框信息
            log(`价格输入框信息:`, 'info');
            log(`  type: ${priceInput.type}`, 'info');
            log(`  placeholder: ${priceInput.placeholder}`, 'info');
            log(`  id: ${priceInput.id}`, 'info');
            log(`  className: ${priceInput.className}`, 'info');

            // 点击并聚焦
            priceInput.click();
            priceInput.focus();
            await sleep(300);

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;

            // 清空当前值
            nativeInputValueSetter.call(priceInput, '');
            priceInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(100);

            // 输入 cents 格式的价格
            const priceStr = priceInCents.toString();
            nativeInputValueSetter.call(priceInput, priceStr);

            log(`设置输入框值为: ${priceStr}`, 'info');

            // 触发事件
            const events = [
                new Event('input', { bubbles: true }),
                new Event('change', { bubbles: true }),
                new KeyboardEvent('keydown', { bubbles: true, key: priceStr }),
                new KeyboardEvent('keyup', { bubbles: true, key: priceStr }),
            ];

            events.forEach(event => priceInput.dispatchEvent(event));
            priceInput.dispatchEvent(new Event('blur', { bubbles: true }));

            await sleep(500);

            // 验证输入
            const currentValue = priceInput.value;
            const currentNum = parseFloat(currentValue);

            log(`验证输入: 当前值="${currentValue}", 数值=${currentNum}`, 'info');

            // 允许一定的浮点数误差
            if (Math.abs(currentNum - priceInCents) < 0.1) {
                log(`✅ 价格已输入: ${priceInCents}¢ (${price})`, 'success');
            } else {
                log(`⚠️ 价格输入可能失败`, 'warn');
                log(`  期望值: ${priceInCents}¢ (${price})`, 'warn');
                log(`  当前值: "${currentValue}" (数值: ${currentNum})`, 'warn');

                // 尝试逐字符输入
                log('尝试逐字符输入价格...', 'info');
                await this.typePriceSlowly(priceInput, priceStr);
            }

            await sleep(500);
        }

        /**
         * 逐字符输入价格 (备用方法)
         */
        async typePriceSlowly(input, priceStr) {
            input.click();
            input.focus();
            await sleep(200);

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;

            // 清空
            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(100);

            // 逐字符输入
            for (let i = 0; i < priceStr.length; i++) {
                const char = priceStr[i];
                nativeInputValueSetter.call(input, input.value + char);

                // 触发输入事件
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true,
                    key: char,
                    keyCode: char.charCodeAt(0)
                }));
                input.dispatchEvent(new KeyboardEvent('keyup', {
                    bubbles: true,
                    key: char,
                    keyCode: char.charCodeAt(0)
                }));

                await sleep(50); // 每个字符之间暂停
            }

            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            await sleep(500);

            // 再次验证
            const currentValue = input.value;
            const currentNum = parseFloat(currentValue);
            const expectedNum = parseFloat(priceStr);

            if (Math.abs(currentNum - expectedNum) < 0.1) {
                log(`✅ 逐字符输入成功: ${currentValue}`, 'success');
            } else {
                log(`❌ 逐字符输入也失败`, 'error');
                log(`  期望: ${priceStr}`, 'error');
                log(`  当前: ${currentValue}`, 'error');
                throw new Error(`价格输入失败: 期望 ${priceStr}, 实际 ${currentValue}`);
            }
        }

        /**
         * 查找选项按钮
         */
        async findOptionButton(optionName) {
            log(`正在查找选项: ${optionName}`, 'info');
            const buttons = Array.from(document.querySelectorAll('button'));
            const optionButton = buttons.find(btn =>
                btn.textContent.includes(optionName) &&
                btn.textContent.includes('$') &&
                btn.textContent.includes('%')
            );

            if (!optionButton) {
                throw new Error(`未找到选项: ${optionName}`);
            }

            log(`找到选项按钮: ${optionName}`, 'success');
            return optionButton;
        }

        /**
         * 查找交易按钮 (YES/NO)
         */
        async findTradeButton(type) {
            log(`正在查找 ${type} 交易按钮`, 'info');
            await sleep(500);

            const buttons = Array.from(document.querySelectorAll('button'));
            const tradeButton = buttons.find(btn => {
                const text = btn.textContent.trim();
                return text.startsWith(type) ||
                       (text.includes(type) && text.includes('¢'));
            });

            if (!tradeButton) {
                throw new Error(`未找到 ${type} 交易按钮`);
            }

            log(`找到 ${type} 交易按钮: ${tradeButton.textContent.trim()}`, 'success');
            return tradeButton;
        }

        /**
         * 查找金额输入框
         */
        async findAmountInput() {
            log(`正在查找金额输入框`, 'info');
            const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
            const amountInput = inputs.find(input => {
                const value = input.value || input.placeholder || '';
                return (value === '0' || value === '') &&
                       input.placeholder === '0';
            });

            if (!amountInput) {
                throw new Error('未找到金额输入框');
            }

            log(`找到金额输入框`, 'success');
            return amountInput;
        }

        /**
         * 输入金额
         */
        async inputAmount(amount) {
            log(`准备输入金额: ${amount}`, 'info');
            const input = await this.findAmountInput();

            input.click();
            input.focus();
            await sleep(300);

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;

            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(100);

            nativeInputValueSetter.call(input, amount.toString());

            const events = [
                new Event('input', { bubbles: true }),
                new Event('change', { bubbles: true }),
                new KeyboardEvent('keydown', { bubbles: true, key: amount.toString() }),
                new KeyboardEvent('keyup', { bubbles: true, key: amount.toString() }),
            ];

            events.forEach(event => input.dispatchEvent(event));
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            await sleep(500);

            if (input.value !== amount.toString()) {
                log(`⚠️ 金额输入可能失败,当前值: ${input.value}`, 'warn');
            } else {
                log(`✅ 金额已输入: ${amount}`, 'success');
            }

            await sleep(500);
        }

        /**
         * 查找购买按钮
         */
        async findBuyButton() {
            log('正在查找购买按钮...', 'info');

            let buyButton = null;

            const divs = Array.from(document.querySelectorAll('div'));
            buyButton = divs.find(div => {
                const text = div.textContent.trim();
                const classes = div.className || '';
                return text.startsWith('Buy') &&
                       (text.includes('YES') || text.includes('NO')) &&
                       classes.includes('rounded-full') &&
                       (classes.includes('bg-white') || classes.includes('cursor-pointer'));
            });

            if (!buyButton) {
                const allElements = Array.from(document.querySelectorAll('div, button'));
                buyButton = allElements.find(el => {
                    const text = el.textContent.trim();
                    return /^Buy\s+.+\s*-\s*(YES|NO)$/.test(text);
                });
            }

            if (!buyButton) {
                throw new Error('未找到购买按钮');
            }

            log(`找到购买按钮: ${buyButton.textContent.trim()}`, 'success');
            return buyButton;
        }

        /**
         * 等待交易确认
         */
        async waitForTransactionConfirmation(tradeType) {
            log(`⏳ 等待${tradeType}交易确认中(最多60秒)...`, 'info');

            for (let i = 0; i < 60; i++) {
                if (this.shouldStop) return false;

                await sleep(1000);

                // 检查持仓变化
                const hasPositions = await this.checkPositions();

                if (hasPositions) {
                    log('✅ 检测到交易已确认 (持仓出现)', 'success');
                    return true;
                }

                if (i % 5 === 0 && i > 0) {
                    log(`⏳ 继续等待交易确认... (${60-i}秒剩余)`, 'info');
                }
            }

            log('⚠️ 60秒内未检测到交易确认', 'warn');
            return false;
        }

        /**
         * 监控订单成交情况
         * 检测订单是否成交,或者是否出现持仓
         */
        async monitorOrders() {
            log('👀 开始监控订单成交...', 'info');

            const maxWait = CONSTANTS.MAKER_MAX_WAIT_TIME;
            const checkInterval = CONSTANTS.MAKER_ORDER_CHECK_INTERVAL;
            let elapsedTime = 0;

            while (elapsedTime < maxWait && !this.shouldStop) {
                await sleep(checkInterval);
                elapsedTime += checkInterval;

                // 方法1: 检查持仓变化 (如果订单成交,会有持仓)
                const hasPositions = await this.checkPositions();
                if (hasPositions) {
                    log('✅ 检测到持仓出现 (订单可能已成交)', 'success');
                    return true;
                }

                // 方法2: 查询订单状态 (可选)
                if (elapsedTime % 5000 === 0) { // 每5秒查询一次订单状态
                    const walletAddress = await getWalletAddress();
                    if (walletAddress) {
                        const orders = await fetchCurrentOrders(walletAddress, this.marketInfo.topicId);
                        if (orders && orders.length > 0) {
                            // 检查是否有订单已完成
                            const completedOrders = orders.filter(o => o.status === 2);
                            if (completedOrders.length > 0) {
                                log(`✅ 检测到 ${completedOrders.length} 个订单已完成`, 'success');
                                return true;
                            }
                        }
                    }
                }

                if (elapsedTime % 10000 === 0) {
                    log(`⏳ 等待成交中... (${(elapsedTime/1000).toFixed(0)}秒)`, 'info');
                }
            }

            log('⏰ 等待超时,未检测到成交', 'warn');
            return false;
        }

        /**
         * 检查持仓
         */
        async checkPositions() {
            // 复用现有的持仓检查逻辑
            const walletAddr = await getWalletAddress();

            if (walletAddr) {
                try {
                    const apiResult = await fetchPositionsFromAPI(walletAddr);
                    if (apiResult !== null) {
                        return parseAPIPositions(apiResult);
                    } else {
                        return await checkPositionsFromDOM();
                    }
                } catch (error) {
                    log(`检查持仓异常: ${error.message}, 降级到DOM方案`, 'error');
                    return await checkPositionsFromDOM();
                }
            } else {
                return await checkPositionsFromDOM();
            }
        }

        /**
         * 取消未成交的订单 (使用撤单 API)
         */
        async cancelPendingOrders() {
            log('🚫 正在取消未成交订单...', 'info');

            // 获取钱包地址
            const walletAddress = await getWalletAddress();
            if (!walletAddress) {
                log('⚠️ 无法获取钱包地址,跳过撤单', 'warn');
                return false;
            }

            // 查询当前订单
            const orders = await fetchCurrentOrders(walletAddress, this.marketInfo.topicId);
            if (!orders || orders.length === 0) {
                log('✅ 没有待撤销的订单', 'success');
                return true;
            }

            // 撤销所有未完成的订单
            let cancelCount = 0;
            for (const order of orders) {
                // status: 1 = 进行中, 2 = 已完成, 3 = 已取消
                if (order.status === 1 && order.transNo) {
                    log(`准备撤销订单: ${order.transNo}`, 'info');
                    const success = await cancelOrder(order.transNo, order.chainId);
                    if (success) {
                        cancelCount++;
                    }
                    await sleep(500); // 避免请求过快
                }
            }

            if (cancelCount > 0) {
                log(`✅ 成功撤销 ${cancelCount} 个订单`, 'success');
                return true;
            } else {
                log('⚠️ 没有可撤销的订单', 'warn');
                return false;
            }
        }

        /**
         * 处理成交后的卖出
         */
        async handleFilledOrder() {
            log('💰 正在处理成交订单...', 'info');

            // 等待一段时间让持仓确认
            await sleep(2000);

            // 检查当前 tab
            const buyTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                const text = tab.textContent.trim();
                return text === 'Sell';
            });

            const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                const text = tab.textContent.trim();
                return text === 'Sell';
            });

            // 确保在 Sell tab
            if (buyTab && buyTab.hasAttribute('data-selected')) {
                log('切换到 Sell tab', 'info');
                if (sellTab) {
                    sellTab.click();
                    await sleep(1000);
                }
            }

            // 复用现有的卖出逻辑
            await this.sellPosition();
        }

        /**
         * 卖出持仓 (复用 OpinionTrader 的逻辑)
         */
        async sellPosition() {
            log('准备卖出持仓...', 'info');

            const positionRows = Array.from(document.querySelectorAll('tbody tr'));
            let soldCount = 0;

            for (const row of positionRows) {
                const cells = Array.from(row.querySelectorAll('td'));

                if (cells.length < 3) continue;

                const outcomeText = cells[0].textContent.trim();
                const hasSellButton = row.textContent.includes('Sell');

                if ((outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton) {
                    const sharesCell = cells[1];
                    const sharesText = sharesCell.textContent.trim();
                    log(`找到持仓: ${outcomeText}, Shares: ${sharesText}`, 'info');

                    const sellButton = Array.from(row.querySelectorAll('button')).find(btn =>
                        btn.textContent.trim() === 'Sell'
                    );

                    if (sellButton) {
                        log('点击持仓表格中的 Sell 按钮', 'info');
                        sellButton.click();

                        await sleep(2000);

                        // 查找 Max 按钮和 Shares 输入框
                        const sellTabPanel = Array.from(document.querySelectorAll('div[role="tabpanel"]')).find(panel => {
                            return panel.id && panel.id.includes('content-1') &&
                                   panel.getAttribute('data-state') === 'open';
                        });

                        if (!sellTabPanel) {
                            log('⚠️ 未找到卖出 tab 面板', 'warn');
                            continue;
                        }

                        let maxButton = null;
                        let sharesInput = null;

                        for (let attempt = 0; attempt < 15; attempt++) {
                            const maxButtons = Array.from(sellTabPanel.querySelectorAll('button'));
                            maxButton = maxButtons.find(btn => btn.textContent.trim() === 'Max');

                            const labels = Array.from(sellTabPanel.querySelectorAll('p'));
                            const sharesLabel = labels.find(p => p.textContent.trim() === 'Shares');

                            if (sharesLabel) {
                                let container = sharesLabel.parentElement;
                                while (container && !sharesInput) {
                                    sharesInput = container.querySelector('input[type="text"]');
                                    if (!sharesInput) {
                                        container = container.parentElement;
                                    }
                                }
                            }

                            if (maxButton && sharesInput) {
                                break;
                            }

                            await sleep(500);
                        }

                        if (!maxButton || !sharesInput) {
                            log('⚠️ Max按钮或Shares输入框未找到', 'warn');
                            continue;
                        }

                        maxButton.click();
                        await sleep(500);

                        // 查找确认卖出按钮
                        let sellConfirmButton = null;
                        for (let attempt = 0; attempt < 15; attempt++) {
                            const divs = Array.from(sellTabPanel.querySelectorAll('div'));
                            sellConfirmButton = divs.find(div => {
                                const text = div.textContent.trim();
                                return text.includes('Sell') &&
                                       (text.includes('YES') || text.includes('NO')) &&
                                       div.className.includes('rounded-full');
                            });

                            if (sellConfirmButton) {
                                break;
                            }

                            await sleep(500);
                        }

                        if (!sellConfirmButton) {
                            log('⚠️ 未找到确认卖出按钮', 'warn');
                            continue;
                        }

                        // 等待按钮可操作
                        for (let attempt = 0; attempt < 20; attempt++) {
                            const buttonClasses = sellConfirmButton.className || '';
                            const isDisabled = buttonClasses.includes('cursor-not-allowed') ||
                                             sellConfirmButton.hasAttribute('disabled');

                            if (!isDisabled) {
                                break;
                            }

                            await sleep(500);
                        }

                        sellConfirmButton.click();
                        soldCount++;

                        log('⏳ 请在MetaMask钱包中确认卖出交易...', 'warn');

                        // 等待交易确认
                        await sleep(5000);
                    }
                }
            }

            if (soldCount === 0) {
                log('⚠️ 未找到可卖出的持仓', 'warn');
            } else {
                log(`✅ 成功提交 ${soldCount} 个卖出订单`, 'success');
            }
        }

        /**
         * Maker 模式主循环
         */
        async runMakerLoop() {
            try {
                log('=== 开始 Maker 模式交易循环 ===', 'info');
                this.isRunning = true;
                this.shouldStop = false;

                let cycleCount = 0;
                while (!this.shouldStop) {
                    cycleCount++;
                    log(`\n========== Maker 循环 #${cycleCount} ==========`, 'info');

                    // 1. 初始化市场信息
                    if (this.shouldStop) throw new Error('用户手动停止');
                    await this.initMarketInfo();

                    // 2. 获取订单簿深度
                    if (this.shouldStop) throw new Error('用户手动停止');
                    await this.fetchDepth();

                    // 3. 同时挂买卖单
                    if (this.shouldStop) throw new Error('用户手动停止');
                    await this.placeBothOrders();

                    // 4. 监控成交
                    if (this.shouldStop) throw new Error('用户手动停止');
                    const hasFilled = await this.monitorOrders();

                    if (hasFilled) {
                        // 5. 取消未成交订单
                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.cancelPendingOrders();

                        // 6. 卖出成交仓位
                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.handleFilledOrder();

                        log('✅ 本轮交易完成,准备下一轮...', 'success');
                    } else {
                        log('⚠️ 超时未成交,重新开始...', 'warn');
                    }

                    await sleep(1000);
                    log(`========== 循环 #${cycleCount} 完成 ==========\n`, 'success');
                }

                log('=== Maker 交易循环已停止 ===', 'success');

            } catch (error) {
                if (error.message === '用户手动停止') {
                    log('⚠️ 交易已被用户停止', 'warn');
                } else {
                    log(`❌ Maker 交易失败: ${error.message}`, 'error');
                    throw error;
                }
            } finally {
                this.isRunning = false;
                this.shouldStop = false;
            }
        }

        start() {
            if (this.isRunning) {
                log('Maker 交易已在运行中', 'warn');
                return;
            }

            if (!this.config.marketUrl) {
                log('请先配置市场链接', 'error');
                return;
            }

            if (!window.location.href.includes(this.config.marketUrl.replace('https://app.opinion.trade', ''))) {
                log(`正在跳转到市场页面: ${this.config.marketUrl}`, 'info');
                window.location.href = this.config.marketUrl;
                return;
            }

            this.runMakerLoop();
        }

        stop() {
            if (!this.isRunning) {
                log('Maker 交易未在运行中', 'warn');
                return;
            }

            log('正在停止 Maker 交易...', 'info');
            this.shouldStop = true;
        }
    }

    class OpinionTrader {
        constructor() {
            this.config = Config.getAll();
            this.isRunning = false;
            this.shouldStop = false;
            this.walletAddress = null;
        }

        /**
         * 获取钱包地址(带缓存)
         */
        async getWalletAddress() {
            if (!this.walletAddress) {
                this.walletAddress = await getWalletAddress();
                if (!this.walletAddress) {
                    log('⚠️ 无法获取钱包地址,将使用DOM方案', 'warn');
                }
            }
            return this.walletAddress;
        }

        /**
         * 检查持仓(API优先,降级DOM)
         */
        async checkPositions() {
            log('正在检查持仓...', 'info');

            // 如果配置禁用API或未获取到钱包地址,直接使用DOM
            if (!this.config.useApiFirst) {
                log('API优先已禁用,使用DOM方案', 'info');
                return await checkPositionsFromDOM();
            }

            // 尝试使用API获取
            const walletAddr = await this.getWalletAddress();

            if (walletAddr) {
                try {
                    const apiResult = await fetchPositionsFromAPI(walletAddr);

                    if (apiResult !== null) {
                        // API请求成功,解析数据
                        return parseAPIPositions(apiResult);
                    } else {
                        // API请求失败,降级到DOM
                        log('⚠️ API请求失败,降级到DOM方案', 'warn');
                        return await checkPositionsFromDOM();
                    }
                } catch (error) {
                    log(`API异常: ${error.message}, 降级到DOM方案`, 'error');
                    return await checkPositionsFromDOM();
                }
            } else {
                // 没有钱包地址,使用DOM方案
                log('⚠️ 无钱包地址,使用DOM方案', 'warn');
                return await checkPositionsFromDOM();
            }
        }

        async findOptionButton(optionName) {
            log(`正在查找选项: ${optionName}`, 'info');
            const buttons = Array.from(document.querySelectorAll('button'));
            const optionButton = buttons.find(btn =>
                btn.textContent.includes(optionName) &&
                btn.textContent.includes('$') &&
                btn.textContent.includes('%')
            );

            if (!optionButton) {
                throw new Error(`未找到选项: ${optionName}`);
            }

            log(`找到选项按钮: ${optionName}`, 'success');
            return optionButton;
        }

        async selectOption(optionName) {
            log(`准备选择选项: ${optionName}`, 'info');
            const button = await this.findOptionButton(optionName);
            button.click();
            await sleep(1000);
            log(`选项已选择`, 'success');
        }

        async findTradeButton(type) {
            log(`正在查找 ${type} 交易按钮`, 'info');
            await sleep(500);

            const buttons = Array.from(document.querySelectorAll('button'));
            const tradeButton = buttons.find(btn => {
                const text = btn.textContent.trim();
                return text.startsWith(type) ||
                       (text.includes(type) && text.includes('¢'));
            });

            if (!tradeButton) {
                throw new Error(`未找到 ${type} 交易按钮`);
            }

            log(`找到 ${type} 交易按钮: ${tradeButton.textContent.trim()}`, 'success');
            return tradeButton;
        }

        async findAmountInput() {
            log(`正在查找金额输入框`, 'info');
            const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
            const amountInput = inputs.find(input => {
                const value = input.value || input.placeholder || '';
                return (value === '0' || value === '') &&
                       input.placeholder === '0';
            });

            if (!amountInput) {
                throw new Error('未找到金额输入框');
            }

            log(`找到金额输入框`, 'success');
            return amountInput;
        }

        async inputAmount(amount) {
            log(`准备输入金额: ${amount}`, 'info');
            const input = await this.findAmountInput();

            input.click();
            input.focus();
            await sleep(300);

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value'
            ).set;

            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(100);

            nativeInputValueSetter.call(input, amount.toString());

            const events = [
                new Event('input', { bubbles: true }),
                new Event('change', { bubbles: true }),
                new KeyboardEvent('keydown', { bubbles: true, key: amount.toString() }),
                new KeyboardEvent('keyup', { bubbles: true, key: amount.toString() }),
            ];

            events.forEach(event => input.dispatchEvent(event));
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            await sleep(500);

            if (input.value !== amount.toString()) {
                log(`⚠️ 金额输入可能失败,当前值: ${input.value}`, 'warn');
            } else {
                log(`✅ 金额已输入: ${amount}`, 'success');
            }

            await sleep(500);
        }

        async findBuyButton() {
            log('正在查找购买按钮...', 'info');

            let buyButton = null;

            const divs = Array.from(document.querySelectorAll('div'));
            buyButton = divs.find(div => {
                const text = div.textContent.trim();
                const classes = div.className || '';
                return text.startsWith('Buy') &&
                       (text.includes('YES') || text.includes('NO')) &&
                       classes.includes('rounded-full') &&
                       (classes.includes('bg-white') || classes.includes('cursor-pointer'));
            });

            if (!buyButton) {
                const allElements = Array.from(document.querySelectorAll('div, button'));
                buyButton = allElements.find(el => {
                    const text = el.textContent.trim();
                    return /^Buy\s+.+\s*-\s*(YES|NO)$/.test(text);
                });
            }

            if (!buyButton) {
                throw new Error('未找到购买按钮');
            }

            log(`找到购买按钮: ${buyButton.textContent.trim()}`, 'success');
            return buyButton;
        }

        async verifyTradeSuccess() {
            log('正在验证交易是否成功...', 'info');
            await sleep(3000);

            const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"]');
            for (const elem of errorElements) {
                if (elem.textContent && elem.textContent.trim()) {
                    log(`⚠️ 检测到错误: ${elem.textContent.trim()}`, 'warn');
                }
            }

            const positionTab = document.querySelector('button[tabindex="0"]');
            if (positionTab) {
                log('✅ 交易可能已成功,请检查持仓页面确认', 'success');
            } else {
                log('⚠️ 无法验证交易是否成功,请手动检查持仓', 'warn');
            }
        }

        async checkWalletConnection() {
            log('检查钱包连接状态...', 'info');
            const connectButton = Array.from(document.querySelectorAll('button')).find(btn =>
                btn.textContent.includes('Connect Wallet')
            );

            if (connectButton) {
                log('⚠️ 钱包未连接,请先连接钱包!', 'error');
                throw new Error('钱包未连接,请先点击"Connect Wallet"按钮连接钱包');
            }

            const balanceText = document.body.textContent;
            const hasBalance = !balanceText.includes('Balance\n-') &&
                              !balanceText.includes('Balance -');

            if (!hasBalance) {
                log('⚠️ 钱包余额为空或未加载!', 'warn');
            }

            log('✅ 钱包已连接', 'success');
        }

        async sellPosition() {
            log('准备卖出持仓...', 'info');

            const positionRows = Array.from(document.querySelectorAll('tbody tr'));
            let soldCount = 0;

            for (const row of positionRows) {
                const cells = Array.from(row.querySelectorAll('td'));

                if (cells.length < 3) continue;

                const outcomeText = cells[0].textContent.trim();
                const hasSellButton = row.textContent.includes('Sell');

                if ((outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton) {
                    const sharesCell = cells[1];
                    const sharesText = sharesCell.textContent.trim();
                    log(`找到持仓: ${outcomeText}, Shares: ${sharesText}`, 'info');

                    const sellButton = Array.from(row.querySelectorAll('button')).find(btn =>
                        btn.textContent.trim() === 'Sell'
                    );

                    if (sellButton) {
                        log('点击持仓表格中的 Sell 按钮', 'info');
                        sellButton.click();

                        log('等待切换到卖出页面...', 'info');
                        let sellTabFound = false;
                        for (let attempt = 0; attempt < 20; attempt++) {
                            const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                                const text = tab.textContent.trim();
                                return text === 'Sell' &&
                                       (tab.hasAttribute('data-selected') ||
                                        tab.getAttribute('aria-selected') === 'true');
                            });

                            if (sellTab) {
                                log('✅ 已切换到卖出页面', 'success');
                                sellTabFound = true;
                                break;
                            }

                            await sleep(500);
                        }

                        if (!sellTabFound) {
                            log('⚠️ 未能切换到卖出页面,跳过此持仓', 'warn');
                            continue;
                        }

                        await sleep(2000);

                        log('开始查找卖出页面元素...', 'info');

                        let sellTabPanel = null;
                        let maxButton = null;
                        let sharesInput = null;
                        let sellConfirmButton = null;

                        for (let attempt = 0; attempt < 10; attempt++) {
                            const tabPanels = Array.from(document.querySelectorAll('div[role="tabpanel"]'));
                            sellTabPanel = tabPanels.find(panel => {
                                return panel.id && panel.id.includes('content-1') &&
                                       panel.getAttribute('data-state') === 'open';
                            });

                            if (sellTabPanel) {
                                log('✅ 找到卖出tab面板', 'success');
                                break;
                            }

                            log(`等待卖出tab面板... (尝试 ${attempt + 1}/10)`, 'info');
                            await sleep(500);
                        }

                        if (!sellTabPanel) {
                            log('⚠️ 未找到激活的tab面板,跳过此持仓', 'warn');
                            continue;
                        }

                        for (let attempt = 0; attempt < 15; attempt++) {
                            const maxButtons = Array.from(sellTabPanel.querySelectorAll('button'));
                            maxButton = maxButtons.find(btn => btn.textContent.trim() === 'Max');

                            const labels = Array.from(sellTabPanel.querySelectorAll('p'));
                            const sharesLabel = labels.find(p => p.textContent.trim() === 'Shares');

                            if (sharesLabel) {
                                let container = sharesLabel.parentElement;
                                while (container && !sharesInput) {
                                    sharesInput = container.querySelector('input[type="text"]');
                                    if (!sharesInput) {
                                        container = container.parentElement;
                                    }
                                }
                            }

                            if (maxButton && sharesInput) {
                                log('✅ Max按钮和Shares输入框已找到', 'success');
                                break;
                            }

                            log(`等待TabPanel内Max按钮和Shares输入框加载... (尝试 ${attempt + 1}/15)`, 'info');
                            await sleep(500);
                        }

                        if (!maxButton || !sharesInput) {
                            log('⚠️ Max按钮或Shares输入框未找到,跳过此持仓', 'warn');
                            continue;
                        }

                        log('点击 Max 按钮设置最大份额', 'info');
                        maxButton.click();
                        await sleep(500);

                        log(`Shares输入框当前值: ${sharesInput.value}`, 'info');

                        log('查找确认卖出按钮...', 'info');
                        for (let attempt = 0; attempt < 15; attempt++) {
                            const divs = Array.from(sellTabPanel.querySelectorAll('div'));
                            sellConfirmButton = divs.find(div => {
                                const text = div.textContent.trim();
                                return text.includes('Sell') &&
                                       (text.includes('YES') || text.includes('NO')) &&
                                       div.className.includes('rounded-full') &&
                                       !div.className.includes('bg-white-16');
                            });

                            if (sellConfirmButton) {
                                log('✅ 找到确认卖出按钮', 'success');
                                break;
                            }

                            log(`等待确认卖出按钮出现... (尝试 ${attempt + 1}/15)`, 'info');
                            await sleep(500);
                        }

                        if (!sellConfirmButton) {
                            log('⚠️ 未找到确认卖出按钮,跳过此持仓', 'warn');
                            continue;
                        }

                        log('等待卖出按钮可操作...', 'info');
                        for (let attempt = 0; attempt < 20; attempt++) {
                            const buttonClasses = sellConfirmButton.className || '';
                            const isDisabled = buttonClasses.includes('cursor-not-allowed') ||
                                             sellConfirmButton.hasAttribute('disabled');

                            if (!isDisabled) {
                                log('✅ 卖出按钮已可操作', 'success');
                                break;
                            }

                            if (attempt % 5 === 0) {
                                log(`继续等待按钮可操作... (尝试 ${attempt + 1}/20)`, 'info');
                            }
                            await sleep(500);
                        }

                        log('点击确认卖出按钮', 'info');
                        sellConfirmButton.click();
                        soldCount++;

                        log('⏳ 请在MetaMask钱包中确认卖出交易...', 'warn');

                        let transactionConfirmed = false;
                        for (let i = 0; i < 60; i++) {
                            await sleep(1000);

                            const buttonStillActive = sellConfirmButton &&
                                !sellConfirmButton.hasAttribute('disabled') &&
                                !sellConfirmButton.className.includes('cursor-not-allowed');

                            const successMessages = Array.from(document.querySelectorAll('*')).filter(el => {
                                const text = el.textContent.trim();
                                return text.includes('Transaction') &&
                                       (text.includes('submitted') ||
                                        text.includes('confirmed') ||
                                        text.includes('success'));
                            });

                            if (!buttonStillActive || successMessages.length > 0) {
                                log('✅ 检测到交易已提交', 'success');
                                transactionConfirmed = true;
                                break;
                            }

                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待钱包确认... (${60-i}秒剩余)`, 'info');
                            }
                        }

                        if (!transactionConfirmed) {
                            log('⚠️ 60秒内未检测到交易确认,但继续执行', 'warn');
                        }

                        log('✅ 卖出订单已提交', 'success');
                        await sleep(2000);
                    }
                }
            }

            if (soldCount === 0) {
                log('⚠️ 未找到可卖出的持仓', 'warn');
            } else {
                log(`✅ 成功提交 ${soldCount} 个卖出订单`, 'success');
            }
        }

        async executeTrade() {
            try {
                log('=== 开始执行交易循环 ===', 'info');
                this.isRunning = true;
                this.shouldStop = false;

                let cycleCount = 0;
                while (!this.shouldStop) {
                    cycleCount++;
                    log(`\n========== 交易循环 #${cycleCount} ==========`, 'info');

                    if (this.shouldStop) throw new Error('用户手动停止');
                    await this.checkWalletConnection();

                    if (this.shouldStop) throw new Error('用户手动停止');
                    if (cycleCount === 1) {
                        await sleep(this.config.waitBeforeTrade * 1000);
                    }

                    const hasPositions = await this.checkPositions();

                    if (hasPositions) {
                        log('📋 检测到持仓,准备卖出...', 'info');

                        log(`⏳ 等待 ${this.config.sellWaitTime} 秒后开始卖出...`, 'info');
                        for (let i = 0; i < this.config.sellWaitTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                        }

                        await this.sellPosition();

                        log('⏳ 等待持仓清空确认...', 'info');
                        let positionsCleared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            const stillHasPositions = await this.checkPositions();

                            if (!stillHasPositions) {
                                log('✅ 持仓已清空', 'success');
                                positionsCleared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓清空... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsCleared) {
                            log('⚠️ 30秒内持仓未完全清空,但继续下一轮', 'warn');
                        }

                        log('✅ 卖出完成,准备开始下一轮交易...', 'success');
                        await sleep(1000);

                    } else {
                        log('📋 当前无持仓,准备买入...', 'info');

                        log('检查当前tab...', 'info');
                        const buyTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                            const text = tab.textContent.trim();
                            return text === 'Buy';
                        });

                        const sellTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(tab => {
                            const text = tab.textContent.trim();
                            return text === 'Sell';
                        });

                        if (sellTab && sellTab.hasAttribute('data-selected')) {
                            log('当前在Sell tab,切换到Buy tab...', 'info');
                            if (buyTab) {
                                buyTab.click();
                                await sleep(1000);
                                log('✅ 已切换到Buy tab', 'success');
                            }
                        } else {
                            log('✅ 当前已在Buy tab', 'success');
                        }

                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.selectOption(this.config.optionName);
                        await sleep(1000);

                        if (this.shouldStop) throw new Error('用户手动停止');
                        const tradeButton = await this.findTradeButton(this.config.tradeType);
                        log(`点击 ${this.config.tradeType} 按钮`, 'info');
                        tradeButton.click();
                        await sleep(1000);

                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.inputAmount(this.config.tradeAmount);
                        await sleep(1000);

                        if (this.shouldStop) throw new Error('用户手动停止');
                        const buyButton = await this.findBuyButton();
                        log('点击购买按钮', 'info');
                        buyButton.click();

                        log('⏳ 请在MetaMask钱包中确认交易...', 'warn');

                        let walletPopupDetected = false;
                        for (let i = 0; i < 10; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                            const metamaskIframe = document.querySelector('iframe[src*="metamask"]') ||
                                                  document.querySelector('[class*="metamask"]') ||
                                                  document.querySelector('[id*="metamask"]');
                            if (metamaskIframe) {
                                walletPopupDetected = true;
                                log('✅ 检测到钱包弹窗,请确认...', 'info');
                                break;
                            }
                        }

                        log('⏳ 等待钱包确认中(最多60秒)...', 'info');
                        let transactionConfirmed = false;
                        for (let i = 0; i < 60; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);

                            const buttonStillActive = buyButton &&
                                buyButton.parentElement &&
                                !buyButton.parentElement.hasAttribute('disabled') &&
                                !buyButton.parentElement.className.includes('cursor-not-allowed');

                            const successMessages = Array.from(document.querySelectorAll('*')).filter(el => {
                                const text = el.textContent.trim();
                                return text.includes('Transaction') &&
                                       (text.includes('submitted') ||
                                        text.includes('confirmed') ||
                                        text.includes('success'));
                            });

                            const positionRows = Array.from(document.querySelectorAll('tbody tr'));
                            const hasPositionsAfterBuy = positionRows.some(row => {
                                const cells = Array.from(row.querySelectorAll('td'));
                                if (cells.length < 3) return false;
                                const outcomeText = cells[0].textContent.trim();
                                const hasSellButton = row.textContent.includes('Sell');
                                return (outcomeText.includes('YES') || outcomeText.includes('NO')) && hasSellButton;
                            });

                            if (!buttonStillActive || successMessages.length > 0 || hasPositionsAfterBuy) {
                                log('✅ 检测到交易已提交', 'success');
                                transactionConfirmed = true;
                                break;
                            }

                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待钱包确认... (${60-i}秒剩余)`, 'info');
                            }
                        }

                        if (!transactionConfirmed) {
                            log('⚠️ 60秒内未检测到交易确认,但继续执行', 'warn');
                        }

                        log('✅ 交易订单已提交', 'success');

                        if (this.shouldStop) throw new Error('用户手动停止');
                        await this.verifyTradeSuccess();

                        log('⏳ 等待持仓确认...', 'info');
                        let positionsAppeared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            const hasPositionsNow = await this.checkPositions();

                            if (hasPositionsNow) {
                                log('✅ 持仓已确认', 'success');
                                positionsAppeared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓出现... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsAppeared) {
                            log('⚠️ 30秒内未检测到持仓出现,但继续执行', 'warn');
                        }

                        log(`⏳ 等待持仓 ${this.config.holdTime} 秒...`, 'info');
                        for (let i = 0; i < this.config.holdTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                            if (i % 10 === 0 && i > 0) {
                                log(`⏳ 持仓倒计时... (${this.config.holdTime-i}秒剩余)`, 'info');
                            }
                        }

                        log('⏳ 持仓时间结束,准备卖出...', 'info');

                        log(`⏳ 等待 ${this.config.sellWaitTime} 秒后开始卖出...`, 'info');
                        for (let i = 0; i < this.config.sellWaitTime; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');
                            await sleep(1000);
                        }

                        if (this.shouldStop) throw new Error('用户手动停止');
                        log('准备卖出持仓...', 'info');
                        await this.sellPosition();

                        log('⏳ 等待持仓清空确认...', 'info');
                        let positionsCleared = false;
                        for (let i = 0; i < 30; i++) {
                            if (this.shouldStop) throw new Error('用户手动停止');

                            const stillHasPositions = await this.checkPositions();

                            if (!stillHasPositions) {
                                log('✅ 持仓已清空', 'success');
                                positionsCleared = true;
                                break;
                            }

                            await sleep(1000);
                            if (i % 5 === 0 && i > 0) {
                                log(`⏳ 继续等待持仓清空... (${30-i}秒剩余)`, 'info');
                            }
                        }

                        if (!positionsCleared) {
                            log('⚠️ 30秒内持仓未完全清空,但继续下一轮', 'warn');
                        }

                        log('✅ 卖出完成,准备开始下一轮交易...', 'success');
                        await sleep(1000);
                    }

                    log(`========== 循环 #${cycleCount} 完成 ==========\n`, 'success');
                }

                log('=== 交易循环已停止 ===', 'success');

            } catch (error) {
                if (error.message === '用户手动停止') {
                    log('⚠️ 交易已被用户停止', 'warn');
                } else {
                    log(`❌ 交易失败: ${error.message}`, 'error');
                    throw error;
                }
            } finally {
                this.isRunning = false;
                this.shouldStop = false;
            }
        }

        start() {
            if (this.isRunning) {
                log('交易已在运行中', 'warn');
                return;
            }

            if (!this.config.marketUrl) {
                log('请先配置市场链接', 'error');
                return;
            }

            if (!window.location.href.includes(this.config.marketUrl.replace('https://app.opinion.trade', ''))) {
                log(`正在跳转到市场页面: ${this.config.marketUrl}`, 'info');
                window.location.href = this.config.marketUrl;
                return;
            }

            this.executeTrade();
        }

        stop() {
            if (!this.isRunning) {
                log('交易未在运行中', 'warn');
                return;
            }

            log('正在停止交易...', 'info');
            this.shouldStop = true;
        }
    }

    // ==================== 配置面板 ====================
    function createConfigPanel() {
        const config = Config.getAll();

        const modal = document.createElement('div');
        modal.id = 'opinion-config-modal';
        modal.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 2147483647;
                display: flex;
                justify-content: center;
                align-items: center;
            ">
                <div style="
                    background: #ffffff;
                    padding: 40px;
                    border-radius: 12px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    max-width: 520px;
                    width: 90%;
                    max-height: 85vh;
                    overflow-y: auto;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                ">
                    <h2 style="
                        color: #1a1a1a;
                        margin: 0 0 30px 0;
                        font-size: 26px;
                        font-weight: 600;
                        letter-spacing: -0.5px;
                    ">⚙️ 交易配置 (API版本)</h2>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">市场链接</label>
                        <input type="text" id="cfg-marketUrl" value="${config.marketUrl}"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">选项名称</label>
                        <input type="text" id="cfg-optionName" value="${config.optionName}"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                        <div>
                            <label style="
                                color: #374151;
                                display: block;
                                margin-bottom: 8px;
                                font-weight: 500;
                                font-size: 14px;
                            ">交易金额</label>
                            <input type="number" id="cfg-tradeAmount" value="${config.tradeAmount}" min="0.01" step="0.01"
                                style="
                                    width: 100%;
                                    padding: 12px 14px;
                                    border: 2px solid #e5e7eb;
                                    border-radius: 8px;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                    box-sizing: border-box;
                                    background: #f9fafb;
                                    color: #1a1a1a;
                                "
                                onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                                onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                            >
                        </div>
                        <div>
                            <label style="
                                color: #374151;
                                display: block;
                                margin-bottom: 8px;
                                font-weight: 500;
                                font-size: 14px;
                            ">持仓时间(秒)</label>
                            <input type="number" id="cfg-holdTime" value="${config.holdTime}" min="1"
                                style="
                                    width: 100%;
                                    padding: 12px 14px;
                                    border: 2px solid #e5e7eb;
                                    border-radius: 8px;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                    box-sizing: border-box;
                                    background: #f9fafb;
                                    color: #1a1a1a;
                                "
                                onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                                onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                            >
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">交易方向</label>
                        <select id="cfg-tradeType"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                cursor: pointer;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                            <option value="YES" ${config.tradeType === 'YES' ? 'selected' : ''}>YES (买入看涨)</option>
                            <option value="NO" ${config.tradeType === 'NO' ? 'selected' : ''}>NO (买入看跌)</option>
                        </select>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">交易模式</label>
                        <select id="cfg-tradeMode"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                cursor: pointer;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                            <option value="taker" ${config.tradeMode === 'taker' ? 'selected' : ''}>Taker (吃单模式)</option>
                            <option value="maker" ${config.tradeMode === 'maker' ? 'selected' : ''}>Maker (挂单模式)</option>
                        </select>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">交易前等待(秒)</label>
                        <input type="number" id="cfg-waitBeforeTrade" value="${config.waitBeforeTrade}" min="0"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="
                            color: #374151;
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 500;
                            font-size: 14px;
                        ">卖出前等待(秒)</label>
                        <input type="number" id="cfg-sellWaitTime" value="${config.sellWaitTime}" min="0"
                            style="
                                width: 100%;
                                padding: 12px 14px;
                                border: 2px solid #e5e7eb;
                                border-radius: 8px;
                                font-size: 14px;
                                transition: all 0.2s;
                                box-sizing: border-box;
                                background: #f9fafb;
                                color: #1a1a1a;
                            "
                            onfocus="this.style.borderColor='#3b82f6'; this.style.background='#ffffff';"
                            onblur="this.style.borderColor='#e5e7eb'; this.style.background='#f9fafb';"
                        >
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr; gap: 15px; margin-bottom: 25px;">
                        <label style="
                            color: #374151;
                            font-weight: 500;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            cursor: pointer;
                        ">
                            <input type="checkbox" id="cfg-useApiFirst" ${config.useApiFirst ? 'checked' : ''}
                                style="
                                    width: 18px;
                                    height: 18px;
                                    cursor: pointer;
                                    accent-color: #3b82f6;
                                "
                            >
                            优先使用API获取持仓(失败自动降级到DOM)
                        </label>

                        <label style="
                            color: #374151;
                            font-weight: 500;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            cursor: pointer;
                        ">
                            <input type="checkbox" id="cfg-enableLog" ${config.enableLog ? 'checked' : ''}
                                style="
                                    width: 18px;
                                    height: 18px;
                                    cursor: pointer;
                                    accent-color: #3b82f6;
                                "
                            >
                            启用详细日志
                        </label>
                    </div>

                    <div style="display: flex; gap: 12px; margin-top: 25px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                        <button id="cfg-save" style="
                            flex: 1;
                            background: #3b82f6;
                            color: white;
                            border: none;
                            padding: 14px 24px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 15px;
                            transition: all 0.2s;
                        " onmouseover="this.style.background='#2563eb';" onmouseout="this.style.background='#3b82f6';">保存配置</button>
                        <button id="cfg-cancel" style="
                            flex: 1;
                            background: #f3f4f6;
                            color: #374151;
                            border: 2px solid #e5e7eb;
                            padding: 14px 24px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 15px;
                            transition: all 0.2s;
                        " onmouseover="this.style.background='#e5e7eb';" onmouseout="this.style.background='#f3f4f6';">取消</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('cfg-save').addEventListener('click', () => {
            const newConfig = {
                marketUrl: document.getElementById('cfg-marketUrl').value,
                optionName: document.getElementById('cfg-optionName').value,
                tradeAmount: parseFloat(document.getElementById('cfg-tradeAmount').value),
                holdTime: parseInt(document.getElementById('cfg-holdTime').value),
                tradeType: document.getElementById('cfg-tradeType').value,
                tradeMode: document.getElementById('cfg-tradeMode').value,
                waitBeforeTrade: parseInt(document.getElementById('cfg-waitBeforeTrade').value),
                sellWaitTime: parseInt(document.getElementById('cfg-sellWaitTime').value),
                useApiFirst: document.getElementById('cfg-useApiFirst').checked,
                enableLog: document.getElementById('cfg-enableLog').checked
            };

            Config.setAll(newConfig);
            log('✅ 配置已保存', 'success');
            modal.remove();
            alert('配置已保存!页面将刷新...');
            location.reload();
        });

        document.getElementById('cfg-cancel').addEventListener('click', () => {
            modal.remove();
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    // ==================== 控制面板 ====================
    function updateTradeButton(isRunning) {
        const button = document.getElementById('start-trade');
        if (!button) return;

        if (isRunning) {
            button.textContent = '停止交易';
            button.style.background = '#ef4444';
            button.onmouseover = () => button.style.background = '#dc2626';
            button.onmouseout = () => button.style.background = '#ef4444';
        } else {
            button.textContent = '开始交易';
            button.style.background = '#3b82f6';
            button.onmouseover = () => button.style.background = '#2563eb';
            button.onmouseout = () => button.style.background = '#3b82f6';
        }
    }

    function createControlPanel() {
        try {
            log('正在创建控制面板...', 'info');

            if (document.getElementById('opinion-auto-trader-panel')) {
                log('控制面板已存在,跳过创建', 'warn');
                return;
            }

            const panel = document.createElement('div');
            panel.id = 'opinion-auto-trader-panel';
            panel.innerHTML = `
                <div style="
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #ffffff;
                    padding: 16px 20px;
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                    z-index: 2147483646;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    min-width: 200px;
                    border: 1px solid #e5e7eb;
                ">
                    <div style="color: #1a1a1a; font-size: 15px; font-weight: 600; margin-bottom: 12px; letter-spacing: -0.3px;">
                        🤖 Opinion Trader <span id="mode-badge" style="
                            font-size: 11px;
                            padding: 2px 8px;
                            border-radius: 4px;
                            background: #3b82f6;
                            color: white;
                            margin-left: 4px;
                        ">${Config.get('tradeMode') === 'maker' ? 'Maker' : 'Taker'}</span>
                    </div>
                    <button id="start-trade" style="
                        background: #3b82f6;
                        color: white;
                        border: none;
                        padding: 10px 16px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        margin: 6px 0;
                        width: 100%;
                        transition: all 0.2s;
                    " onmouseover="this.style.background='#2563eb';" onmouseout="this.style.background='#3b82f6';">开始交易</button>
                    <button id="open-config" style="
                        background: #f3f4f6;
                        color: #374151;
                        border: 2px solid #e5e7eb;
                        padding: 10px 16px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        margin: 6px 0;
                        width: 100%;
                        transition: all 0.2s;
                    " onmouseover="this.style.background='#e5e7eb';" onmouseout="this.style.background='#f3f4f6';">配置</button>
                </div>
            `;

            const addToBody = () => {
                if (document.body) {
                    document.body.appendChild(panel);
                    log('✅ 控制面板已创建', 'success');

                    document.getElementById('start-trade').addEventListener('click', () => {
                        if (currentTrader && currentTrader.isRunning) {
                            currentTrader.stop();
                            updateTradeButton(false);
                            currentTrader = null;
                        } else {
                            const config = Config.getAll();
                            const tradeMode = config.tradeMode;

                            // 根据交易模式选择不同的交易器
                            let trader;
                            if (tradeMode === 'maker') {
                                log('🎯 启动 Maker 模式', 'info');
                                trader = new MakerTrader();
                            } else {
                                log('🎯 启动 Taker 模式', 'info');
                                trader = new OpinionTrader();
                            }

                            currentTrader = trader;

                            const originalExecuteTrade = trader.executeTrade ?
                                trader.executeTrade.bind(trader) :
                                trader.runMakerLoop.bind(trader);

                            const wrappedMethod = async function() {
                                try {
                                    updateTradeButton(true);
                                    await originalExecuteTrade();
                                } finally {
                                    updateTradeButton(false);
                                    if (currentTrader === trader) {
                                        currentTrader = null;
                                    }
                                }
                            };

                            // 绑定包装后的方法
                            if (tradeMode === 'maker') {
                                trader.runMakerLoop = wrappedMethod;
                            } else {
                                trader.executeTrade = wrappedMethod;
                            }

                            trader.start();
                        }
                    });

                    document.getElementById('open-config').addEventListener('click', () => {
                        createConfigPanel();
                    });
                } else {
                    log('等待 body 元素...', 'warn');
                    setTimeout(addToBody, 100);
                }
            };

            addToBody();

        } catch (error) {
            log(`❌ 创建控制面板失败: ${error.message}`, 'error');
            console.error(error);
        }
    }

    // ==================== 初始化 ====================
    function init() {
        log('=== Opinion Auto Trader (API版本) 已加载 ===', 'success');
        log('当前配置: ' + JSON.stringify(Config.getAll()), 'info');

        GM_registerMenuCommand('⚙️ 打开配置', () => createConfigPanel());
        GM_registerMenuCommand('▶️ 开始交易', () => {
            const trader = new OpinionTrader();
            trader.start();
        });
        GM_registerMenuCommand('🔄 重置配置', () => {
            if (confirm('确定要重置所有配置吗?')) {
                Config.reset();
                log('配置已重置', 'success');
                alert('配置已重置!');
            }
        });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createControlPanel);
        } else {
            createControlPanel();
        }

        // 无论配置如何,都等待手动启动
        log('✅ 脚本已加载完成', 'success');
        log('💡 点击页面右上角的"开始交易"按钮启动自动交易', 'info');
        log('💡 或使用油猴菜单: ▶️ 开始交易', 'info');
    }

    init();

})();
