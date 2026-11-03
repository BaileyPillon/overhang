#include <cmath>
#include <array>
#include <vector>
#include <cstdio>
int main(){std::array<double,3> a{1,4,9};std::vector<double> v;for(auto x:a)v.push_back(std::sqrt(x));
printf("C++17 %.1f %.1f %.1f N=%d\n",v[0],v[1],v[2],(int)NVAL);return 0;}
