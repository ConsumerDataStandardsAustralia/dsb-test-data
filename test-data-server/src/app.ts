import express, { request } from 'express';
import { NextFunction, Request, Response } from 'express';
import endpoints from '../data/endpoints.json';
import {
    EndpointConfig, CdrConfig, cdrHeaderValidator, DefaultBankingEndpoints,
    DefaultEnergyEndpoints,
    cdrJwtScopes,
    DsbAuthConfig,
    cdrTokenValidator,
    IUserService,
    cdrEndpointValidator,
    cdrScopeValidator,
    cdrResourceValidator
} from '@cds-au/holder-sdk'
import { MongoData } from './services/database.service';
import { IDatabase } from './services/database.interface';
import bodyParser from 'body-parser';
import * as dotenv from 'dotenv';
import { SingleData } from './services/single.service';
import cors from 'cors';
import path from 'path';
import { readFileSync } from 'fs';
import * as https from 'https'

import { Issuer } from 'openid-client';
import { AuthService } from './services/auth-service';
import { cdrAuthorization } from './modules/auth';
import { DsbCdrUser } from './models/user';

dotenv.config();
console.log(JSON.stringify(process.env, null, 2));

const exp = express;
const app = express();

const port = `${process.env.APP_LISTENTING_PORT}`;
const authServerUrl = `${process.env.AUTH_SERVER_URL}`;
let basePath = '/cds-au/v1';


// This implementation uses a MongoDB. To use some other persistent storage
// you need to implement the IDatabase interface
const connString = `mongodb://${process.env.MONGO_HOSTNAME}:${process.env.MONGO_PORT}`
const corsAllowedOrigin = process.env.CORS_ALLOWED_ORIGINS?.split(",")

const isSingleStr = process.env.DATA_IS_SINGLE_DOCUMENT;
var isSingle = isSingleStr?.toLowerCase() == 'true' ? true : false;
var isSingle = isSingleStr?.toLowerCase() == 'false' ? false : true;

console.log(`Connection string is ${connString}`);

var dbService: IDatabase;
if (isSingle == true)
    dbService = new SingleData(connString, process.env.MONGO_DB as string);
else
    dbService = new MongoData(connString, process.env.MONGO_DB as string);

let authService = new AuthService(dbService);

// Add a list of allowed origins.
// If you have more origins you would like to add, you can add them to the array below.
//const allowedOrigins = corsAllowedOrigin;
const corsOptions: cors.CorsOptions = {
    origin: corsAllowedOrigin
};
app.use(cors(corsOptions));

const router = exp.Router();
const sampleEndpoints = [...endpoints] as EndpointConfig[];
const dsbOptions: CdrConfig = {
    endpoints: sampleEndpoints
}
const certFile =path.join(__dirname, '/security/mock-data-holder/tls', process.env.CERT_FILE as string)
const keyFile = path.join(__dirname, '/security/mock-data-holder/tls', process.env.CERT_KEY_FILE as string)
const rCert = readFileSync(certFile, 'utf8');
const rKey = readFileSync(keyFile, 'utf8');
const otions = {
    key: rKey,
    cert: rCert
}

let authOption: DsbAuthConfig = {
    scopeFormat: 'LIST',
    endpoints: sampleEndpoints,
    basePath: '/resource'
}
let endpointValidatorOptions: CdrConfig = {
    endpoints: sampleEndpoints,
    basePath: '/resource'
}

let headerValidatorOptions: CdrConfig = {
    endpoints: sampleEndpoints,
    basePath: '/resource'
}

var userService: IUserService = {
    getUser: function (): DsbCdrUser | undefined {
        return authService?.authUser;
    }
};

// dbService.connectDatabase()
//     .then(() => {
//         initAuthService();     
//     })
//     .catch((error: Error) => {
//         console.error("Database connection failed", error);
//         process.exit();
//     })


// app.use(unless(cdrJwtScopes(authOption), "/login-data/energy", "/jwks"));
// app.use(unless(cdrTokenValidator(tokenValidatorOptions), "/login-data/energy", "/jwks"));
app.use(cdrEndpointValidator(endpointValidatorOptions));
app.use(cdrHeaderValidator(headerValidatorOptions))
//app.use(unless(cdrHeaderValidator(dsbOptions), "/login-data/energy", "/jwks"));
app.use(unless(setCurrentUserInfo, 
        "/login-data/energy", "/jwks", `${basePath}/energy/plans`))
app.use(cdrScopeValidator(userService));
app.use(cdrResourceValidator(userService));
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))

app.use('/', router);


async function initaliseApp() {
    try {
        const otions = {
            key: rKey,
            cert: rCert
        }
        await dbService.connectDatabase()
        console.log(`Interrogating discovery endpoint : ${authServerUrl}`);  
        let init = await authService.initAuthService();
        if (init == false) {
            console.log('WARNING: Authentication service could not be initalised');
        }
    
        https.createServer(otions, app)
        .listen(port, () => {
            console.log('Server started');
        })
    } catch(e: any) {
        console.log(`FATAL: could not start server${e?.message}`);
    }

}

async function setCurrentUserInfo(req: Request, res: Response, next: NextFunction) {
    if (req.headers?.authorization == null) next();

    let temp = req.headers?.authorization as string;
    let tokenIsValid = await authService.verifyAccessToken(temp) 
    if (tokenIsValid == false) {
        res.status(401).json('Not authorized');
        return;
    }
    if (authService?.authUser?.customerId == null) {
        res.status(401).json('Not authorized');
        return;         
    }
    var servicePoints: string[] | undefined;
    //if (authService.authUser == null) next();
    if (authService.authUser?.accounts)
        servicePoints = await dbService.getServicePointsForCustomer(authService?.authUser?.customerId);

    userService = {
        getUser(): DsbCdrUser|undefined {     
           let user: DsbCdrUser|undefined = {
               customerId: authService?.authUser?.customerId as string,
               scopes_supported: authService.authUser?.scopes_supported,
               accounts: authService.authUser?.accounts,
               energyServicePoints: servicePoints,
               loginId: authService.authUser?.loginId as string,
               encodeUserId: authService.authUser?.encodeUserId as string,
               encodedAccounts: authService.authUser?.encodedAccounts
           }
           return user;
       }
   }
   next();
}

// function used to determine if the middleware is to be bypassed for the given 'paths'
function unless(middleware:any, ...paths: any) {
    return function(req: Request, res: Response, next: NextFunction) {
      const pathCheck = paths.some((path:string) => path == req.path);
      pathCheck ? next() : middleware(req, res, next);
    };
};
  
// anything /energy/accounts/<something-else> needs  to be routed like this 
router.get(`${basePath}/energy/accounts/:accountId`, async (req, res) => {

    try {
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
    
        console.log(`Received request on ${port} for ${req.url}`);
        var excludes = ["invoices", "billing", "balances"];
        if (excludes.indexOf(req.params?.accountId) == -1) {
            let result = await dbService.getEnergyAccountDetails(authService.authUser?.customerId as string, req.params?.accountId)
            if (result == null) {
                res.sendStatus(404);
            } else {
                result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
                res.send(result);
            }
        }
        if (req.params?.accountId == "invoices") {
            let result = await dbService.getBulkInvoicesForUser(authService.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
            } else {
                res.send(result);
            }
        }
    
        if (req.params?.accountId == "billing") {
            let result = await dbService.getBulkBilllingForUser(authService.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
            } else {
                res.send(result);
            }
        }
    
        if (req.params?.accountId == "balances") {
            let result = await dbService.getBulkBalancesForUser(authService.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
            } else {
                res.send(result);
            }
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }


})

// anything /energy/electricity/servicepoints/<something-else> needs  to be routed like this 
router.get(`${basePath}/energy/electricity/servicepoints/:servicePointId`, async (req, res) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        var excludes = ["usage", "der"];
        if (excludes.indexOf(req.params?.servicePointId) == -1) {
            let result = await dbService.getServicePointDetails(authService.authUser?.customerId as string, req.params?.servicePointId)
            if (result == null) {
                res.sendStatus(404);
            } else {
                result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
                res.send(result);
            }
        }
        if (req.params?.servicePointId == "usage") {
            console.log(`Received request on ${port} for ${req.url}`);
            let result = await dbService.getBulkUsageForUser(authService.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
            } else {
                result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
                res.send(result);
            }
        }
    
        if (req.params?.servicePointId == "der") {
            let result = await dbService.getBulkDerForUser(authService.authUser?.customerId as string)
            if (result == null) {
                res.sendStatus(404);
            } else {
                res.send(result);
            }
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
})

// this endpoint requires authentication
app.get(`${basePath}/energy/accounts`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let ret = await dbService.getEnergyAccounts(authService.authUser?.customerId as string, authService.authUser?.accounts as string[]);
        ret.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
        res.send(ret);
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// tget list of service points, returns EnergyServicePointListResponse
app.get(`${basePath}/energy/electricity/servicepoints`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getServicePoints(authService.authUser?.customerId as string);
        //let result: any = null;
        if (result == null) {
            res.sendStatus(404);
            return;
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

app.get(`${basePath}/common/customer/detail`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getCustomerDetails(authService.authUser?.customerId as string);
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

app.get(`${basePath}/common/customer`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getCustomerDetails(authService.authUser?.customerId as string);
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

app.get(`${basePath}/energy/plans/:planId`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getEnergyPlanDetails(req.params.planId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    

});

// this endpoint does NOT require authentication
app.get(`${basePath}/energy/plans/`, async (req: Request, res: Response, next: NextFunction) => {
    console.log(`Received request on ${port} for ${req.url}`);
    try {
        let result = await dbService.getEnergyAllPlans()
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }

});

// get usage fort a service point, returns EnergyUsageListResponse
app.get(`${basePath}/energy/electricity/servicepoints/:servicePointId/usage`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getUsageForServicePoint(authService.authUser?.customerId as string, req.params.servicePointId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get der for a service point, returns EnergyDerDetailResponse
app.get(`${basePath}/energy/electricity/servicepoints/:servicePointId/der`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let userId = getUserId(req);
        if (userId == undefined) {
            return;
        }
        let result = await dbService.getDerForServicePoint(userId, req.params.servicePointId);
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get der for a service point, returns EnergyDerDetailResponse
app.post(`${basePath}/energy/electricity/servicepoints/der`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getDerForMultipleServicePoints(authService.authUser?.customerId as string, req.body?.accountIds)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get account details for an accountID, returns EnergyAccountDetailResponseV2
app.get(`${basePath}/energy/accounts/:accountId`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        var excludes = ["invoices"];
        if (excludes.indexOf(req.params?.accountId) == -1) {
            let result = await dbService.getEnergyAccountDetails(authService.authUser?.customerId as string, req.params?.accountId)
            if (result == null) {
                res.sendStatus(404);
            } else {
                result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
                res.send(result);
            }
        }
        else {
            app.get(`${basePath}/energy/accounts/`);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get account details for an accountID, returns EnergyAccountDetailResponseV2
app.get(`${basePath}/energy/accounts/:accountId/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
       // let userId = getUserId(req);
       // if (userId == undefined) {
       //     res.status(401).json('Not authorized');
       //     return;
       // }
        let result = await dbService.getInvoicesForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get invoices for account, returns EnergyInvoiceListResponse
app.get(`${basePath}/energy/accounts/:accountId/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        if (accountIsValid(req.params?.accountId) == false){
            res.status(401).json('Not authorized');
            return;      
        }
        let result = await dbService.getInvoicesForAccount(authService.authUser?.customerId as string, req.params.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/accounts/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    console.log(`Received POST request on ${port} for ${req.url}`);

    let result = await dbService.getInvoicesForMultipleAccounts(authService.authUser?.customerId as string, req.body?.data?.accountIds)
    if (result == null) {
        res.sendStatus(404);
    } else {
        res.send(result);
    }
});


// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/accounts/balances`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received POST request on ${port} for ${req.url}`);
        let result = await dbService.getBalancesForMultipleAccount(authService.authUser?.customerId as string, req.body?.data?.accountIds)
        if (result == null) {
            res.sendStatus(404);
        } else {
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get invoices for account, returns EnergyInvoiceListResponse
app.get(`${basePath}/energy/accounts/invoices`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received GET request on ${port} for ${req.url}`);

        if (!authService?.authUser?.customerId) return;
        let result = await dbService.getBulkInvoicesForUser(authService?.authUser?.customerId);
        if (result == null) {
            res.sendStatus(404);
        } else {
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get invoices for account, returns EnergyInvoiceListResponse
app.post(`${basePath}/energy/electricity/servicepoints/usage`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getUsageForMultipleServicePoints(authService?.authUser?.customerId as string, req.body?.data?.servicePointIds)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get concessions for account, returns EnergyConcessionsResponse
app.get(`${basePath}/energy/accounts/:accountId/concessions`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);

        let result = await dbService.getConcessionsForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get balance for account, returns EnergyBalanceResponse
app.get(`${basePath}/energy/accounts/:accountId/balance`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let st = `Received request on ${port} for ${req.url}`;
        let result = await dbService.getBalanceForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get payment schedule for account, returns EnergyPaymentScheduleResponse
app.get(`${basePath}/energy/accounts/:accountId/payment-schedule`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getPaymentSchedulesForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});

// get payment schedule for account, returns EnergyPaymentScheduleResponse
app.get(`${basePath}/energy/accounts/:accountId/billing`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getTransactionsForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// get billing for a number of accounts
app.post(`${basePath}/energy/accounts/billing`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getBillingForMultipleAccounts(authService.authUser?.customerId as string, req.body?.data?.accountIds)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }    
});


app.get(`${basePath}/energy/accounts/:accountId/payment-schedule`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        let result = await dbService.getPaymentSchedulesForAccount(authService.authUser?.customerId as string, req.params?.accountId)
        if (result == null) {
            res.sendStatus(404);
        } else {
            result.links.self = req.protocol + '://' + req.get('host') + req.originalUrl;
            res.send(result);
        }
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// Get the information required by the Auth server to displaythe login screen
app.get(`/login-data/:sector`, async (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(`Received request on ${port} for ${req.url}`);
        if (sectorIsValid(req.params?.sector) == false){
            res.status(404).json('Not Found');
            return;      
        }
        let customers = await dbService.getLoginInformation(req.params?.sector)
        let result = { Customers: customers};
        res.send(result);
    } catch(e) {
        console.log('Error:', e);
        res.sendStatus(500);
    }
});

// In the absence of an IdP we use the accessToken as userId
function getUserId(req: any): string | undefined {
    return authService?.authUser?.customerId;
}

function accountIsValid(accountId: string): boolean{
    let idx = authService?.authUser?.accounts?.findIndex(x => x == accountId)
    return (idx != undefined && idx > -1);
}

function sectorIsValid(sector: string) : boolean {
    let validSectors = ['energy', 'banking']
    let st = sector.toLowerCase();
    return validSectors.indexOf(st)>-1
}

initaliseApp();

