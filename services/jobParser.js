function parseJobPost(text) {
    const source = String(text || '');

    const emails = [
        ...new Set(
            (
                source.match(
                    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
                ) || []
            )
        ),
    ];

    const phones = [
        ...new Set(
            (
                source.match(
                    /(?:\+91[\s-]?)?[6-9]\d{9}|(?:\+91[\s-]?)?\d{10}|(?:\d{5}\s\d{5})/g
                ) || []
            )
        ),
    ]
        .map(p => p.trim())
        .filter(p => p.replace(/\D/g, '').length >= 10);

    let role = '';

    const rolePatterns = [
        /hiring for[:\s#]+([^\n!,]+)/i,
        /opening(?:s)? for[:\s]+([^\n!,]+)/i,
        /position[:\s]+([^\n!,]+)/i,
        /role[:\s]+([^\n!,]+)/i,
        /job title[:\s]+([^\n!,]+)/i,
        /#([A-Za-z]+(?:developer|engineer|designer|architect|analyst|manager))/i,
    ];

    for (const pattern of rolePatterns) {
        const match = source.match(pattern);

        if (match) {
            role = (match[1] || match[0])
                .replace(/#/g, '')
                .trim();

            break;
        }
    }

    let company = '';

    const companyPatterns = [
        /^([A-Z][A-Za-z\s&]+(?:Technologies|Tech|Solutions|Systems|Pvt\.?\s?Ltd|Inc|Corp|Group|Services|Labs|Studio|Software|Consulting|Digital|Ventures)[^\n]*)/m,

        /([A-Z][A-Za-z\s&]+(?:Technologies|Tech|Solutions|Systems|Pvt\.?\s?Ltd|Inc|Corp|Group|Services|Labs|Studio|Software|Consulting|Digital))/,
    ];

    for (const pattern of companyPatterns) {
        const match = source.match(pattern);

        if (match) {
            company = match[1].trim();
            break;
        }
    }

    const experienceMatch = source.match(
        /(\d+)\+?\s*(?:yrs?|years?)\s*(?:of\s*)?(?:exp(?:erience)?)?/i
    );

    const expRequired = experienceMatch
        ? `${experienceMatch[1]}+ years`
        : '';

    const locationMatch = source.match(
        /(?:location|loc|based in)[:\s]+([^\n,]+)/i
    );

    const location = locationMatch
        ? locationMatch[1].trim()
        : '';

    const noticePeriodMatch = source.match(
        /(?:notice\s*period|max\s*np|np)[:\s]+([^\n]+)/i
    );

    const noticePeriod = noticePeriodMatch
        ? noticePeriodMatch[1].trim()
        : '';

    return {
        emails,
        phones,
        role,
        company,
        expRequired,
        location,
        noticePeriod,
    };
}

module.exports = {
    parseJobPost,
};