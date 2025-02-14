export type Collection = {
    collection: string;
    count: number;
    recent_count: number;
    min: string;
    max: string;
    isNew?: boolean;
}

export type Did = {
    did: string;
    count: number;
    min: string;
    max: string;
}

export type NSIDLv2 = {
    nsidlv2: string;
}


export type DailySummary = {
    day: number;
    count: number;
}