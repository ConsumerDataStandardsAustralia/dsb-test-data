import * as mongoDB from "mongodb";

export interface IDatabase {
    connectDatabase() : Promise<void>;
    disconnectDatabase() : Promise<void>;
    getCollections(): Promise<string[]>;

    loadPlans(planArray: any[]): Promise<number> 

    loadCustomers(custArray: any): Promise<number>;

    deleteAllCustomers(): Promise<number>;

    deleteAllPlans(): Promise<number>;

    getEnergyAccounts(customerId: string): Promise<any>;

    addPlan(plan: any): Promise<mongoDB.ObjectId|null> 

    addCustomer(plan: any): Promise<mongoDB.ObjectId|null> 
}