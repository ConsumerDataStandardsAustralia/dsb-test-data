import express, { request } from 'express';
import { NextFunction, Request, Response } from 'express';
import endpoints from '../data/endpoints.json';
import {
    EndpointConfig, CdrConfig, cdrHeaderValidator,
    IUserService,
    cdrEndpointValidator,
    cdrScopeValidator,
    cdrResourceValidator
} from "@cds-au/holder-sdk"

import { IDatabase } from './services/database.interface';
import bodyParser from 'body-parser';
import * as dotenv from 'dotenv';
import { SingleData } from './services/single.service';
import cors from 'cors';
import path from 'path';
import { readFileSync } from 'fs';
import * as https from 'https'
import { DsbCdrUser } from './models/user';
import { authService, cdrAuthorization } from './modules/auth';
import { ResponseErrorListV2 } from 'consumer-data-standards/common';
import {
    EnergyAccount, EnergyAccountDetailResponse, EnergyAccountListResponse, EnergyBalanceListResponse,
    EnergyBalanceResponse, EnergyBillingListResponse, EnergyBillingTransactionV2, EnergyConcession,
    EnergyConcessionsResponse, EnergyDerDetailResponse, EnergyDerListResponse, EnergyDerRecord,
    EnergyInvoiceListResponse, EnergyPaymentSchedule, EnergyPaymentScheduleResponse, EnergyPlan,
    EnergyPlanDetailV2, EnergyPlanListResponse, EnergyPlanResponse, EnergyServicePoint, EnergyServicePointDetail,
    EnergyServicePointDetailResponse, EnergyServicePointListResponse, EnergyUsageListResponse,
    EnergyUsageRead, EnergyInvoice
} from 'consumer-data-standards/energy';
import { buildErrorMessageForServicePoint, getLinksPaginated, getMetaPaginated, paginateData, sectorIsValid } from './utils/paginate-data';

dotenv.config();
console.log(JSON.stringify(process.env, null, 2));

const exp = express;
const app = express();
const port = `${process.env.APP_LISTENTING_PORT}`;

let basePath = '/cds-au/v1';


// This implementation uses a MongoDB. To use some other persistent storage
// you need to implement the IDatabase interface
const connString = `mongodb://${process.env.MONGO_HOSTNAME}:${process.env.MONGO_PORT}`
const corsAllowedOrigin = process.env.CORS_ALLOWED_ORIGINS?.split(",")

console.log(`Connection string is ${connString}`);

var dbService: IDatabase;
dbService = new SingleData(connString, process.env.MONGO_DB as string);


// Add a list of allowed origins.
// If you have more origins you would like to add, you can add them to the array below.
//const allowedOrigins = corsAllowedOrigin;
const corsOptions: cors.CorsOptions = {
    origin: corsAllowedOrigin
};
app.use(cors(corsOptions));
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
const router = exp.Router();

const sampleEndpoints = [...endpoints] as EndpointConfig[];
const certFile = path.join(__dirname, '/security/mock-data-holder/tls', process.env.CERT_FILE as string)
const keyFile = path.join(__dirname, '/security/mock-data-holder/tls', process.env.CERT_KEY_FILE as string)
const rCert = readFileSync(certFile, 'utf8');
const rKey = readFileSync(keyFile, 'utf8');

let endpointValidatorOptions: CdrConfig = {
    endpoints: sampleEndpoints
}

let headerValidatorOptions: CdrConfig = {
    endpoints: sampleEndpoints
}

// The user service which provides the callback function for the 
// cdrResourceValidator middleware function to accounts associated with user
var userService: IUserService = {
    getUser: function (): DsbCdrUser | undefined {
        if (authService()?.authUser == null)
            return undefined;
        let user: DsbCdrUser | undefined = {
            customerId: authService().authUser?.customerId as string,
            scopes_supported: authService().authUser?.scopes_supported,
            accountsEnergy: authService().authUser?.accountsEnergy,
            energyServicePoints: authService().authUser?.energyServicePoints,
            loginId: authService().authUser?.loginId as string,
            encodeUserId: authService().authUser?.encodeUserId as string,
            encodedAccounts: authService().authUser?.encodedAccounts
        }
        return user;
    }
};

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))

// This is a function which interacts with the Authorisation server developed by the ACCC
app.use(cdrAuthorization(dbService, endpointValidatorOptions));
app.use(unless(cdrEndpointValidator(endpointValidatorOptions), "/login-data/energy", "/health"));
app.use(unless(cdrHeaderValidator(headerValidatorOptions), "/login-data/energy", "/health"));
app.use(unless(cdrScopeValidator(userService), "/login-data/energy", "/jwks", `/health`));
app.use(unless(cdrResourceValidator(userService), "/login-data/energy", "/jwks", `/health`));


app.use('/', router);


async function initaliseApp() {
    try {
        const otions = {
            key: rKey,
            cert: rCert
        }
        console.log(`Connecting to database : ${connString}`);
        await dbService.connectDatabase();
        console.log(`Connected.`);
        https.createServer(otions, app)
            .listen(port, () => {
                console.log(`Server started. Listening on port ${port}`);
            })
    } catch (e: any) {
        console.log(`FATAL: could not start server${e?.message}`);
    }
}

// this endpoint requires authentication
app.get(`/health`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let user = authService()?.authUser?.loginId;
        res.send(`Service is running....${user}`);
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// function used to determine if the middleware is to be bypassed for the given 'paths'
function unless(middleware: any, ...paths: any) {
    return function (req: Request, res: Response, next: NextFunction) {
        const pathCheck = paths.some((path: string) => path == req.path);
        pathCheck ? next() : middleware(req, res, next);
    };
};

// anything /energy/accounts/<something-else> needs  to be routed like this 
router.get(`${basePath}/energy/accounts/:accountId`, async (req, res) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        var excludes = ["invoices", "billing", "balances"];
        if (excludes.indexOf(req.params?.accountId) == -1) {
            let data: any | undefined = await dbService.getEnergyAccountDetails(authService()?.authUser?.customerId as string, req.params?.accountId)
            if (data == null) {
                res.sendStatus(404);
            } else {
                let resp: EnergyAccountDetailResponse = {
                    data: data,
                    links: {
                        self: req.protocol + '://' + req.get('host') + req.originalUrl
                    }
                }
                res.send(resp);
                return;
            }
        }
        if (req.params?.accountId == "invoices") {
            let result: EnergyInvoice[] = await dbService.getBulkInvoicesForUser(authService()?.authUser?.customerId as string, req?.query)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {
                let paginatedData = paginateData(result, req.query);
                // check if this is an error object
                if (paginatedData?.errors != null) {
                    res.statusCode = 422;
                    // In this case paginatedData is actually an error object
                    res.send(paginatedData);
                    return;
                }
                else {
                    let listResponse: EnergyInvoiceListResponse = {
                        links: getLinksPaginated(req, req.query, result.length),
                        meta: getMetaPaginated(req.query, result.length),
                        data: {
                            invoices: paginatedData
                        }
                    }
                    res.send(listResponse);
                    return;
                }
            }
        }

        if (req.params?.accountId == "billing") {
            let result = await dbService.getBulkBilllingForUser(authService()?.authUser?.customerId as string, req.query)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {

                let paginatedData = paginateData(result, req.query);
                // check if this is an error object
                if (paginatedData?.errors != null) {
                    res.statusCode = 422;
                    // In this case paginatedData is actually an error object
                    res.send(paginatedData);
                    return;
                }
                else {
                    let listResponse: EnergyBillingListResponse = {
                        links: getLinksPaginated(req, req.query, result.length),
                        meta: getMetaPaginated(req.query, result.length),
                        data: {
                            transactions: paginatedData
                        }
                    }
                    res.send(listResponse);
                    return;
                }
            }
        }

        if (req.params?.accountId == "balances") {
            let result: any[] = await dbService.getBulkBalancesForUser(authService()?.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {

                let paginatedData = paginateData(result, req.query);
                // check if this is an error object
                if (paginatedData?.errors != null) {
                    res.statusCode = 422;
                    // In this case paginatedData is actually an error object
                    res.send(paginatedData);
                    return;
                }
                else {
                    let listResponse: EnergyBalanceListResponse = {
                        links: getLinksPaginated(req, req.query, result.length),
                        meta: getMetaPaginated(req.query, result.length),
                        data: {
                            balances: paginatedData
                        }
                    }
                    res.send(listResponse);
                    return;
                }
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
})

// anything /energy/electricity/servicepoints/<something-else> needs  to be routed like this 
router.get(`${basePath}/energy/electricity/servicepoints/:servicePointId`, async (req, res) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        var excludes = ["usage", "der"];
        if (excludes.indexOf(req.params?.servicePointId) == -1) {
            let result: EnergyServicePointDetail = await dbService.getServicePointDetails(authService()?.authUser?.customerId as string, req.params?.servicePointId)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {
                let resp: EnergyServicePointDetailResponse = {
                    data: result,
                    links: {
                        self: req.protocol + '://' + req.get('host') + req.originalUrl
                    }
                }
                res.send(resp);
                return;
            }
        }
        if (req.params?.servicePointId == "usage") {
            console.log(`Received request on ${port} for ${req.url}`);
            let result: EnergyUsageRead[] = await dbService.getBulkUsageForUser(authService()?.authUser?.customerId as string, req?.query)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {

                let paginatedData = paginateData(result, req.query);
                // check if this is an error object
                if (paginatedData?.errors != null) {
                    res.statusCode = 422;
                    // In this case paginatedData is actually an error object
                    res.send(paginatedData);
                    return;
                }
                else {
                    let listResponse: EnergyUsageListResponse = {
                        links: getLinksPaginated(req, req.query, result.length),
                        meta: getMetaPaginated(req.query, result.length),
                        data: {
                            reads: paginatedData
                        }
                    }
                    res.send(listResponse);
                    return;
                }
            }
        }
        if (req.params?.servicePointId == "der") {
            let result: EnergyDerRecord[] = await dbService.getBulkDerForUser(authService()?.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
                return;
            } else {

                let paginatedData = paginateData(result, req.query);
                // check if this is an error object
                if (paginatedData?.errors != null) {
                    res.statusCode = 422;
                    // In this case paginatedData is actually an error object
                    res.send(paginatedData);
                    return;
                }
                else {
                    let listResponse: EnergyDerListResponse = {
                        links: getLinksPaginated(req, req.query, result.length),
                        meta: getMetaPaginated(req.query, result.length),
                        data: {
                            derRecords: paginatedData
                        }
                    }
                    res.send(listResponse);
                    return;
                }
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
})

// this endpoint requires authentication
app.get(`${basePath}/energy/accounts`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyAccount[] = await dbService.getEnergyAccounts(authService()?.authUser?.customerId as string, authService()?.authUser?.accountsEnergy as string[], req.query);
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyAccountListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        accounts: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// tget list of service points, returns EnergyServicePointListResponse
app.get(`${basePath}/energy/electricity/servicepoints`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyServicePoint[] = await dbService.getServicePoints(authService()?.authUser?.customerId as string);
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyServicePointListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        servicePoints: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

app.get(`${basePath}/common/customer/detail`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getCustomerDetails(authService()?.authUser?.customerId as string);
        if (result == null || result?.data == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

app.get(`${basePath}/common/customer`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getCustomerDetails(authService()?.authUser?.customerId as string);
        if (result == null || result?.data == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

app.get(`${basePath}/energy/plans/:planId`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let data: EnergyPlanDetailV2 | null = await dbService.getEnergyPlanDetails(req.params.planId)
        if (data == null) {
            res.sendStatus(404);
            return;
        } else {
            let result: EnergyPlanResponse = {
                data: data,
                links: {
                    self: req.protocol + '://' + req.get('host') + req.originalUrl
                }
            }
            res.send(result);
            return;
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }

});

// this endpoint does NOT require authentication
app.get(`${basePath}/energy/plans/`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyPlan[] = await dbService.getEnergyAllPlans(req.query);
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyPlanListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        plans: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get usage fort a service point, returns EnergyUsageListResponse
app.get(`${basePath}/energy/electricity/servicepoints/:servicePointId/usage`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyUsageRead[] = await dbService.getUsageForServicePoint(authService()?.authUser?.customerId as string, req.params.servicePointId, req?.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyUsageListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        reads: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get der for a service point, returns EnergyDerDetailResponse
app.get(`${basePath}/energy/electricity/servicepoints/:servicePointId/der`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        // find service point in user object, if it is not a service point associated with
        if ((await isServicePointsForUser(authService()?.authUser?.customerId as string, req.params.servicePointId)) == false) {
            let errorList = buildErrorMessageForServicePoint(req.params.servicePointId, "Invalid Service Point", "DER");
            res.status(404).json(errorList);
            return;
        }
        let data: EnergyDerRecord | undefined = await dbService.getDerForServicePoint(authService()?.authUser?.customerId as string, req.params.servicePointId);
        if (data == null) {
            let errorList = buildErrorMessageForServicePoint(req.params.servicePointId, "Unavailable Service Point", "DER");
            res.status(404).json(errorList);
            return;
        } else {
            let ret: EnergyDerDetailResponse = {
                data: data,
                links: {
                    self: req.protocol + '://' + req.get('host') + req.originalUrl
                },
                meta: {}
            }
            res.send(ret);
            return;
        }
    } catch (e) {
        console.log('Error:', e);
        res.status(500);
        return;
    }
});

// get der for a list service point, returns EnergyDerListResponse
app.post(`${basePath}/energy/electricity/servicepoints/der`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyDerRecord[] = await dbService.getDerForMultipleServicePoints(authService()?.authUser?.customerId as string, req.body?.data?.servicePointIds);
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyDerListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        derRecords: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }

});

// get invoices for account, returns EnergyInvoiceListResponse
app.get(`${basePath}/energy/accounts/:accountId/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyInvoice[] = await dbService.getInvoicesForAccount(authService()?.authUser?.customerId as string, req.params.accountId, req.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyInvoiceListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        invoices: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/accounts/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received POST request on ${port} for ${req.url}`);
        let result: EnergyInvoice[] = await dbService.getInvoicesForMultipleAccounts(authService()?.authUser?.customerId as string, req.body?.data?.accountIds, req.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyInvoiceListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        invoices: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});


// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/accounts/balances`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received POST request on ${port} for ${req.url}`);
        let result: any[] = await dbService.getBalancesForMultipleAccount(authService()?.authUser?.customerId as string, req.body?.data?.accountIds)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyBalanceListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        balances: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/electricity/servicepoints/usage`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyUsageRead[] = await dbService.getUsageForMultipleServicePoints(authService()?.authUser?.customerId as string, req.body?.data?.servicePointIds, req.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyUsageListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        reads: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get concessions for account, returns EnergyConcessionsResponse
app.get(`${basePath}/energy/accounts/:accountId/concessions`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyConcession[] | undefined = await dbService.getConcessionsForAccount(authService()?.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {
            let ret: EnergyConcessionsResponse = {
                links: {
                    self: req.protocol + '://' + req.get('host') + req.originalUrl
                },
                meta: {},
                data: {
                    concessions: result
                }
            }
            res.send(ret);
            return;
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get balance for account, returns EnergyBalanceResponse
app.get(`${basePath}/energy/accounts/:accountId/balance`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let st = `Received request on ${port} for ${req.url}`;
        let result = await dbService.getBalanceForAccount(authService()?.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {
            let ret: EnergyBalanceResponse = {
                links: {
                    self: req.protocol + '://' + req.get('host') + req.originalUrl
                },
                meta: {},
                data: {
                    balance: result
                }
            }
            res.send(ret);
            return;
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get payment schedule for account, returns EnergyPaymentScheduleResponse
app.get(`${basePath}/energy/accounts/:accountId/payment-schedule`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyPaymentSchedule[] = await dbService.getPaymentSchedulesForAccount(authService()?.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {
            let ret: EnergyPaymentScheduleResponse = {
                links: {
                    self: req.protocol + '://' + req.get('host') + req.originalUrl
                },
                meta: {},
                data: {
                    paymentSchedules: result
                }
            }
            res.send(ret);
            return;
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get payment schedule for account, returns EnergyPaymentScheduleResponse
app.get(`${basePath}/energy/accounts/:accountId/billing`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyBillingTransactionV2[] = await dbService.getBillingForAccount(authService().authUser?.customerId as string, req.params?.accountId, req?.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyBillingListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        transactions: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get billing for a number of accounts
app.post(`${basePath}/energy/accounts/billing`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result: EnergyBillingTransactionV2[] = await dbService.getBillingForMultipleAccounts(authService()?.authUser?.customerId as string, req.body?.data?.accountIds, req.query)
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {

            let paginatedData = paginateData(result, req.query);
            // check if this is an error object
            if (paginatedData?.errors != null) {
                res.statusCode = 422;
                // In this case paginatedData is actually an error object
                res.send(paginatedData);
                return;
            }
            else {
                let listResponse: EnergyBillingListResponse = {
                    links: getLinksPaginated(req, req.query, result.length),
                    meta: getMetaPaginated(req.query, result.length),
                    data: {
                        transactions: paginatedData
                    }
                }
                res.send(listResponse);
                return;
            }
        }
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// Get the information required by the Auth server to displaythe login screen
app.get(`/login-data/:sector`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        if (sectorIsValid(req.params?.sector) == false) {
            res.status(404).json('Not Found');
            return;
        }
        let customers = await dbService.getLoginInformation(req.params?.sector)
        let result = { Customers: customers };
        res.send(result);
    } catch (e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

async function isServicePointsForUser(customerId: string, servicePointId: string): Promise<boolean> {
    let retVal: boolean = false;
    if (userService != null) {
        let idx = (await userService.getUser())?.energyServicePoints?.findIndex((x: string) => servicePointId);
        retVal = (idx != null) && (idx > - 1) ? true : false;
    }
    return retVal
}

initaliseApp();

