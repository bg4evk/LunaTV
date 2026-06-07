/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { parseStringPromise } from 'xml2js';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';


/**
 * POST /api/acg/acgrip
 * 搜索 ACG.RIP 磁力资源（需要登录，支持分页）
 */
export async function POST(req: NextRequest) {
  // 权限检查：需要登录
  const authInfo = getAuthInfoFromCookie(req);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { keyword, page = 1 } = await req.json();

    if (!keyword || typeof keyword !== 'string') {
      return NextResponse.json(
        { error: '搜索关键词不能为空' },
        { status: 400 }
      );
    }

    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) {
      return NextResponse.json(
        { error: '搜索关键词不能为空' },
        { status: 400 }
      );
    }

    // 验证页码
    const pageNum = parseInt(String(page), 10);
    if (isNaN(pageNum) || pageNum < 1) {
      return NextResponse.json(
        { error: '页码必须是大于0的整数' },
        { status: 400 }
      );
    }

    // ACG 搜索缓存：30分钟
    const ACG_CACHE_TIME = 30 * 60; // 30分钟（秒）
    const cacheKey = `acg-acgrip-${trimmedKeyword}-page${pageNum}`;

    console.log(`🔍 检查 ACG.RIP 搜索缓存: ${cacheKey}`);

    // 尝试从缓存获取
    try {
      const cached = await db.getCache(cacheKey);
      if (cached) {
        console.log(`✅ ACG.RIP 搜索缓存命中: "${trimmedKeyword}" 第${pageNum}页`);
        return NextResponse.json({
          ...cached,
          fromCache: true,
          cacheSource: 'database',
          cacheTimestamp: new Date().toISOString()
        });
      }

      console.log(`❌ ACG.RIP 搜索缓存未命中: "${trimmedKeyword}" 第${pageNum}页`);
    } catch (cacheError) {
      console.warn('ACG.RIP 搜索缓存读取失败:', cacheError);
      // 缓存失败不影响主流程，继续执行
    }

    // 请求 acg.rip RSS
    const searchUrl = `https://acg.rip/page/${pageNum}.xml?term=${encodeURIComponent(trimmedKeyword)}`;

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`ACG.RIP API 请求失败: ${response.status}`);
    }

    const xmlData = await response.text();

    // 解析 XML
    const parsed = await parseStringPromise(xmlData);

    if (!parsed?.rss?.channel?.[0]?.item) {
      return NextResponse.json({
        keyword: trimmedKeyword,
        page: pageNum,
        total: 0,
        items: [],
      });
    }

    const items = parsed.rss.channel[0].item;

    // 转换为标准格式
    const results = items.map((item: any) => {
      const description = item.description?.[0] || '';

      // 提取描述中的图片（如果有）
      let images: string[] = [];
      if (description) {
        const imgMatches = description.match(/src="([^"]+)"/g);
        if (imgMatches) {
          images = imgMatches.map((match: string) => {
            const urlMatch = match.match(/src="([^"]+)"/);
            return urlMatch ? urlMatch[1] : '';
          }).filter(Boolean);
        }
      }

      const title = item.title?.[0] || '';
      const link = item.link?.[0] || '';
      const guid = item.guid?.[0] || link || `${title}-${item.pubDate?.[0] || ''}`;
      const pubDate = item.pubDate?.[0] || '';
      const torrentUrl = item.enclosure?.[0]?.$?.url || '';

      return {
        title,
        link,
        guid,
        pubDate,
        torrentUrl,
        description,
        images,
      };
    });

    const responseData = {
      keyword: trimmedKeyword,
      page: pageNum,
      total: results.length,
      items: results,
    };

    // 保存到缓存
    try {
      await db.setCache(cacheKey, responseData, ACG_CACHE_TIME);
      console.log(`💾 ACG.RIP 搜索结果已缓存: "${trimmedKeyword}" 第${pageNum}页 - ${results.length} 个结果, TTL: ${ACG_CACHE_TIME}s`);
    } catch (cacheError) {
      console.warn('ACG.RIP 搜索缓存保存失败:', cacheError);
    }

    return NextResponse.json(responseData);
  } catch (error: any) {
    console.error('ACG.RIP 搜索失败:', error);
    return NextResponse.json(
      { error: error.message || '搜索失败' },
      { status: 500 }
    );
  }
}
