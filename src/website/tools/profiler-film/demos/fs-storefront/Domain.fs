namespace FsStorefront

type Product = { Sku: string; Name: string; Price: decimal }

type Order = { Id: int; Items: Product list; Total: decimal; Invoice: string }

type Stage =
    | Browsing
    | CheckedOut of total: decimal

type CustomerSession = { Order: Order; Stage: Stage; Snapshot: byte array }
